import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  OPENCAE_CORE_VERSION,
  validateCoreResult,
  validateModelJson,
  volumeMeshToModelJson,
  type CoreResultValidationReport,
  type CoreSolveResult,
  type OpenCAEModelJson,
  type VolumeMeshToModelInput
} from "@opencae/core";
import { solveCoreDynamic, solveCoreStatic } from "@opencae/solver-cpu";
import { buildCoreModelFromCloudMesh } from "./coreModelFromMesh";
import { generateCoreVolumeMeshFromGeometry } from "./mesh/generateCoreVolumeMesh";
import { assertGmshAvailable, CoreCloudMeshingError } from "./mesh/gmsh";
import type { CloudSolveRequest, CoreVolumeMeshArtifact } from "./types";

export const RUNNER_VERSION = "0.1.3";
export const SOLVER_CPU_VERSION = "0.1.2";
export const SERVICE_NAME = "opencae-core-cloud";
const LEGACY_SOLVER_HEALTH_KEY = ["noCalcu", "lix"].join("");
const COMPLEX_GEOMETRY_REQUIRES_CLOUD_GEOMETRY = "Complex geometry requires procedural or uploaded geometry for Core Cloud meshing.";
const DEFAULT_MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const SOLVER_LIMITS = {
  maxDofs: 30000,
  maxIterations: 20000,
  tolerance: 1e-10,
  maxFrames: 500,
  endTimeSeconds: 1,
  minTimeStepSeconds: 0.001,
  minOutputIntervalSeconds: 0.001
};

export type CloudResponse = {
  status: number;
  body: unknown;
};

export async function healthResponse(): Promise<CloudResponse> {
  const gmsh = await assertGmshAvailable();
  return {
    status: 200,
    body: {
      ok: true,
      service: SERVICE_NAME,
      runnerVersion: RUNNER_VERSION,
      coreVersion: OPENCAE_CORE_VERSION,
      solverCpuVersion: SOLVER_CPU_VERSION,
      mesher: "gmsh",
      gmshAvailable: gmsh.available,
      gmshVersion: gmsh.version,
      supportsProceduralGeometry: true,
      supportsUploadedCad: true,
      supportsGeometryToMesh: true,
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolvers: ["sparse_static", "mdof_dynamic"],
      supportsActualVolumeMesh: true,
      supportsPreview: false,
      [LEGACY_SOLVER_HEALTH_KEY]: true,
      noLocalEstimateFallback: true
    }
  };
}

export async function solveResponse(request: unknown): Promise<CloudResponse> {
  if (!isSolveRequest(request)) {
    return errorResponse(400, "invalid-request", "Request must include analysisType and at most one of coreModel, coreVolumeMesh, or geometry.");
  }
  if (request.solverSettings?.allowPreview) {
    return errorResponse(400, "preview-disabled", "OpenCAE Core Cloud does not allow preview solvers.");
  }

  let prepared: PreparedSolveInput;
  try {
    prepared = await prepareSolveInput(request);
  } catch (error) {
    return solvePreparationErrorResponse(request.runId, error);
  }

  const model = prepared.model;
  const validation = validateModelJson(model);
  if (!validation.ok) {
    appendPreparedPhase(prepared, phaseDiagnostic("core_model_validated", "failed", "OpenCAE Core model validation failed.", {
      errorCount: validation.errors.length
    }));
    return {
      status: model.meshProvenance?.meshSource === "display_bounds_proxy" ? 400 : 422,
      body: {
        ok: false,
        runId: request.runId,
        error: {
          code: "validation-failed",
          message: "Input model failed OpenCAE Core validation.",
          report: validation
        },
        diagnostics: prepared.diagnostics,
        artifacts: prepared.artifacts
      }
    };
  }
  appendPreparedPhase(prepared, phaseDiagnostic("core_model_validated", "complete", "OpenCAE Core model validated."));
  appendPreparedPhase(prepared, phaseDiagnostic("core_solve_started", "started", "OpenCAE Core solve started."));
  const solverSettings = boundedSolverSettings(request.analysisType, request.solverSettings, model);
  prepared.diagnostics.push(resourceLimitsDiagnostic(request.analysisType, solverSettings));

  const result =
    request.analysisType === "static_stress"
      ? solveCoreStatic(model, { ...solverSettings, method: "sparse", solverMode: "sparse" })
      : solveCoreDynamic(model, solverSettings);

  if (!result.ok) {
    appendPreparedPhase(prepared, phaseDiagnostic("core_solve_complete", "failed", result.error.message, {
      code: result.error.code
    }));
    return {
      status: result.error.code === "actual-volume-mesh-required" ? 422 : 500,
      body: {
        ok: false,
        runId: request.runId,
        error: result.error,
        diagnostics: [...prepared.diagnostics, result.diagnostics],
        artifacts: prepared.artifacts
      }
    };
  }
  appendPreparedPhase(prepared, phaseDiagnostic("core_solve_complete", "complete", "OpenCAE Core solve completed."));

  const cloudResult = stampCloudProvenance(result.result, prepared.diagnostics, prepared.artifacts);
  const resultValidation = validateCoreResult(cloudResult);
  if (!resultValidation.ok) {
    return {
      status: 500,
      body: {
        ok: false,
        runId: request.runId,
        error: {
          code: "result-validation-failed",
          message: coreResultValidationFailureMessage(resultValidation),
          report: resultValidation
        },
        diagnostics: cloudResult.diagnostics,
        artifacts: cloudResult.artifacts
      }
    };
  }
  cloudResult.diagnostics.push(phaseDiagnostic("result_postprocessed", "complete", "OpenCAE Core result postprocessed."));
  if (cloudResult.artifacts?.meshSummary && typeof cloudResult.artifacts.meshSummary === "object") {
    const meshSummary = cloudResult.artifacts.meshSummary as { phaseDiagnostics?: unknown[] };
    meshSummary.phaseDiagnostics = [
      ...((meshSummary.phaseDiagnostics ?? []) as unknown[]),
      phaseDiagnostic("result_postprocessed", "complete", "OpenCAE Core result postprocessed.")
    ];
  }

  return {
    status: 200,
    body: cloudResult
  };
}

function appendPreparedPhase(prepared: PreparedSolveInput, diagnostic: Record<string, unknown>): void {
  prepared.diagnostics.push(diagnostic);
  const meshSummary = prepared.artifacts?.meshSummary;
  if (meshSummary && typeof meshSummary === "object") {
    const summary = meshSummary as { phaseDiagnostics?: unknown[] };
    summary.phaseDiagnostics = [...(summary.phaseDiagnostics ?? []), diagnostic];
  }
}

export function coreResultValidationFailureMessage(report: CoreResultValidationReport): string {
  return report.errors.some((error) => error.code === "surface-field-length-mismatch")
    ? "Solver surface field length does not match surface mesh node count."
    : "OpenCAE Core result failed surface field alignment validation.";
}

export function createCoreCloudServer() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, await healthResponse());
      return;
    }
    if (request.method === "POST" && request.url === "/solve") {
      if (!isAuthorizedSolveRequest(request.headers)) {
        sendJson(response, errorResponse(401, "unauthorized", "A valid bearer token is required for solve requests."));
        return;
      }
      try {
        sendJson(response, await solveResponse(JSON.parse(await readBody(request))));
      } catch (error) {
        if (isRequestTooLarge(error)) {
          sendJson(response, errorResponse(413, "request-too-large", error.message));
          return;
        }
        sendJson(response, errorResponse(400, "invalid-json", error instanceof Error ? error.message : "Invalid JSON."));
      }
      return;
    }
    sendJson(response, errorResponse(404, "not-found", "Route not found."));
  });
}

function isSolveRequest(value: unknown): value is CloudSolveRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<CloudSolveRequest>;
  const hasCoreModel = !!request.coreModel && typeof request.coreModel === "object";
  const hasCoreVolumeMesh = !!request.coreVolumeMesh && typeof request.coreVolumeMesh === "object";
  const hasGeometry = !!request.geometry && typeof request.geometry === "object";
  return (
    (request.analysisType === "static_stress" || request.analysisType === "dynamic_structural") &&
    [hasCoreModel, hasCoreVolumeMesh, hasGeometry].filter(Boolean).length <= 1
  );
}

type PreparedSolveInput = {
  model: OpenCAEModelJson;
  diagnostics: unknown[];
  artifacts?: Record<string, unknown>;
};

async function prepareSolveInput(request: CloudSolveRequest): Promise<PreparedSolveInput> {
  if (request.coreModel) return { model: request.coreModel, diagnostics: [] };
  if (request.coreVolumeMesh && typeof request.coreVolumeMesh === "object") {
    return { model: volumeMeshToModelJson(request.coreVolumeMesh as VolumeMeshToModelInput), diagnostics: [] };
  }
  if (!request.geometry) {
    throw new CoreCloudMeshingError("geometry-required", COMPLEX_GEOMETRY_REQUIRES_CLOUD_GEOMETRY);
  }
  const phaseDiagnostics = [
    phaseDiagnostic("geometry_received", "complete", `Received ${request.geometry.kind} geometry for Core Cloud meshing.`, {
      geometryKind: request.geometry.kind,
      sampleId: request.geometry.sampleId,
      format: request.geometry.format
    })
  ];
  let volumeMesh: CoreVolumeMeshArtifact;
  try {
    volumeMesh = await generateCoreVolumeMeshFromGeometry(request.geometry, request);
    phaseDiagnostics.push(...meshPhaseDiagnostics(volumeMesh));
  } catch (error) {
    if (error instanceof CoreCloudMeshingError) {
      error.diagnostics.unshift(...phaseDiagnostics, phaseDiagnostic("mesh_generation", "failed", error.message, {
        mesherCode: error.code
      }));
    }
    throw error;
  }

  let model: OpenCAEModelJson;
  try {
    model = buildCoreModelFromCloudMesh({
      study: request.study,
      displayModel: request.displayModel,
      volumeMesh,
      material: request.material,
      materials: request.materials,
      analysisType: request.analysisType,
      solverSettings: request.solverSettings
    });
  } catch (error) {
    throw new CoreCloudMeshingError("model-build-failed", error instanceof Error ? error.message : String(error), {
      diagnostics: [...phaseDiagnostics, phaseDiagnostic("core_model_built", "failed", error instanceof Error ? error.message : String(error))]
    });
  }
  phaseDiagnostics.push(phaseDiagnostic("core_model_built", "complete", "OpenCAE Core model built from generated volume mesh."));
  const meshSummary = meshSummaryArtifact(volumeMesh, phaseDiagnostics);
  const artifacts = {
    generatedCoreModel: model,
    meshSummary
  };
  return {
    model,
    diagnostics: [meshGenerationDiagnostic(volumeMesh), ...phaseDiagnostics],
    artifacts
  };
}

function solvePreparationErrorResponse(runId: string | undefined, error: unknown): CloudResponse {
  if (error instanceof CoreCloudMeshingError) {
    const errorCode = error.code === "geometry-required"
      ? "geometry-required"
      : error.code === "model-build-failed"
        ? "model-build-failed"
        : "meshing-failed";
    return {
      status: error.status,
      body: {
        ok: false,
        runId,
        error: {
          code: errorCode,
          mesherCode: error.code,
          message: error.code === "geometry-required" ? COMPLEX_GEOMETRY_REQUIRES_CLOUD_GEOMETRY : error.message
        },
        diagnostics: error.diagnostics
      }
    };
  }
  return {
    status: 422,
    body: {
      ok: false,
      runId,
      error: {
        code: "model-build-failed",
        message: `${error instanceof Error ? error.message : String(error)} No local estimate fallback was used.`
      }
    }
  };
}

function meshGenerationDiagnostic(volumeMesh: CoreVolumeMeshArtifact): Record<string, unknown> {
  return {
    id: "core-cloud-mesh-generation",
    source: volumeMesh.metadata.source,
    mesher: volumeMesh.metadata.source === "structured_block" ? "structured_block" : "gmsh",
    nodeCount: volumeMesh.metadata.nodeCount,
    elementCount: volumeMesh.metadata.elementCount,
    surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount,
    connectedComponentCount: volumeMesh.metadata.connectedComponentCount,
    physicalGroups: volumeMesh.metadata.physicalGroups,
    meshQuality: volumeMesh.metadata.meshQuality,
    diagnostics: volumeMesh.metadata.diagnostics
  };
}

function stampCloudProvenance(result: CoreSolveResult, diagnostics: unknown[] = [], artifacts: Record<string, unknown> = {}): CoreSolveResult {
  const provenance = {
    ...result.provenance,
    solver: "opencae-core-cloud" as const,
    coreVersion: OPENCAE_CORE_VERSION,
    solverCpuVersion: SOLVER_CPU_VERSION,
    runnerVersion: RUNNER_VERSION
  };
  return {
    ...result,
    summary: {
      ...result.summary,
      provenance
    },
    provenance,
    artifacts: {
      ...(result.artifacts ?? {}),
      ...artifacts
    },
    diagnostics: [...diagnostics, ...result.diagnostics.map((diagnostic) => {
      if (!diagnostic || typeof diagnostic !== "object" || !("id" in diagnostic)) return diagnostic;
      if ((diagnostic as { id?: unknown }).id !== "core-solve-diagnostics") return diagnostic;
      return {
        ...diagnostic,
        coreVersion: OPENCAE_CORE_VERSION,
        solverCpuVersion: SOLVER_CPU_VERSION,
        runnerVersion: RUNNER_VERSION
      };
    })]
  };
}

function phaseDiagnostic(phase: string, status: "started" | "complete" | "failed", message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "core-cloud-phase",
    phase,
    status,
    message,
    ...extra
  };
}

function meshPhaseDiagnostics(volumeMesh: CoreVolumeMeshArtifact): Array<Record<string, unknown>> {
  const diagnostics: Array<Record<string, unknown>> = [];
  if (volumeMesh.metadata.source === "gmsh") {
    diagnostics.push(
      phaseDiagnostic("gmsh_started", "started", "Gmsh geometry meshing started."),
      phaseDiagnostic("gmsh_complete", "complete", "Gmsh geometry meshing completed.")
    );
  }
  diagnostics.push(phaseDiagnostic("mesh_parsed", "complete", "Core volume mesh parsed.", {
    source: volumeMesh.metadata.source,
    nodeCount: volumeMesh.metadata.nodeCount,
    elementCount: volumeMesh.metadata.elementCount,
    surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount,
    connectedComponentCount: volumeMesh.metadata.connectedComponentCount
  }));
  return diagnostics;
}

function meshSummaryArtifact(volumeMesh: CoreVolumeMeshArtifact, phaseDiagnostics: unknown[]): Record<string, unknown> {
  return {
    source: volumeMesh.metadata.source,
    nodeCount: volumeMesh.metadata.nodeCount,
    elementCount: volumeMesh.metadata.elementCount,
    surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount,
    connectedComponentCount: volumeMesh.metadata.connectedComponentCount,
    physicalGroups: volumeMesh.metadata.physicalGroups,
    meshQuality: volumeMesh.metadata.meshQuality,
    diagnostics: volumeMesh.metadata.diagnostics,
    phaseDiagnostics: [...phaseDiagnostics]
  };
}

function errorResponse(status: number, code: string, message: string): CloudResponse {
  return {
    status,
    body: {
      ok: false,
      error: { code, message }
    }
  };
}

export function isAuthorizedSolveRequest(headers: Record<string, unknown> | undefined): boolean {
  const expected = process.env.CORE_CLOUD_API_KEY;
  const header = headers?.authorization;
  return typeof expected === "string" && expected.length > 0 && header === `Bearer ${expected}`;
}

export function readBody(request: Pick<IncomingMessage, "setEncoding" | "on">): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    const maxBytes = maxRequestBytes();
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        reject(requestTooLargeError(maxBytes));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function maxRequestBytes(): number {
  return positiveInteger(process.env.CORE_CLOUD_MAX_REQUEST_BYTES) ?? DEFAULT_MAX_REQUEST_BYTES;
}

function requestTooLargeError(maxBytes: number): Error & { code: string } {
  const error = new Error(`Request body exceeds max bytes ${maxBytes}.`) as Error & { code: string };
  error.code = "request-too-large";
  return error;
}

function isRequestTooLarge(error: unknown): error is Error & { code: string } {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "request-too-large" && error instanceof Error);
}

function boundedSolverSettings(
  analysisType: CloudSolveRequest["analysisType"],
  input: CloudSolveRequest["solverSettings"],
  model: OpenCAEModelJson
): NonNullable<CloudSolveRequest["solverSettings"]> {
  const selectedStep = model.steps?.[positiveInteger(input?.stepIndex) ?? 0];
  const dynamicStep = selectedStep?.type === "dynamicLinear" ? selectedStep : undefined;
  const settings: NonNullable<CloudSolveRequest["solverSettings"]> = {
    ...input,
    maxDofs: Math.min(positiveInteger(input?.maxDofs) ?? SOLVER_LIMITS.maxDofs, SOLVER_LIMITS.maxDofs),
    maxIterations: Math.min(positiveInteger(input?.maxIterations) ?? SOLVER_LIMITS.maxIterations, SOLVER_LIMITS.maxIterations),
    tolerance: Math.max(finiteNumber(input?.tolerance) ?? SOLVER_LIMITS.tolerance, SOLVER_LIMITS.tolerance)
  };
  if (analysisType === "dynamic_structural") {
    settings.maxFrames = Math.min(positiveInteger(input?.maxFrames) ?? SOLVER_LIMITS.maxFrames, SOLVER_LIMITS.maxFrames);
    settings.endTime = Math.min(
      finiteNumber(input?.endTime) ?? finiteNumber(dynamicStep?.endTime) ?? SOLVER_LIMITS.endTimeSeconds,
      SOLVER_LIMITS.endTimeSeconds
    );
    settings.timeStep = Math.max(
      finiteNumber(input?.timeStep) ?? finiteNumber(dynamicStep?.timeStep) ?? SOLVER_LIMITS.minTimeStepSeconds,
      SOLVER_LIMITS.minTimeStepSeconds
    );
    settings.outputInterval = Math.max(
      finiteNumber(input?.outputInterval) ?? finiteNumber(dynamicStep?.outputInterval) ?? settings.timeStep,
      SOLVER_LIMITS.minOutputIntervalSeconds,
      settings.timeStep
    );
    const startTime = finiteNumber(input?.startTime) ?? finiteNumber(dynamicStep?.startTime) ?? 0;
    const maxFrameEndTime = startTime + Math.max((settings.maxFrames ?? SOLVER_LIMITS.maxFrames) - 2, 0) * settings.outputInterval;
    settings.startTime = startTime;
    settings.endTime = Math.min(settings.endTime, maxFrameEndTime);
  }
  return settings;
}

function resourceLimitsDiagnostic(
  analysisType: CloudSolveRequest["analysisType"],
  settings: NonNullable<CloudSolveRequest["solverSettings"]>
): Record<string, unknown> {
  return {
    id: "core-cloud-resource-limits",
    maxDofs: settings.maxDofs,
    maxIterations: settings.maxIterations,
    tolerance: settings.tolerance,
    ...(analysisType === "dynamic_structural"
      ? {
          maxFrames: settings.maxFrames,
          endTime: settings.endTime,
          timeStep: settings.timeStep,
          outputInterval: settings.outputInterval
        }
      : {})
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sendJson(response: ServerResponse, result: CloudResponse): void {
  response.statusCode = result.status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(result.body));
}

const entrypoint = process.argv[1] ?? "";
if (process.env.NODE_ENV !== "test" && (entrypoint.endsWith("server.js") || entrypoint.endsWith("server.bundle.js"))) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createCoreCloudServer().listen(port, "0.0.0.0", () => {
    console.log(`${SERVICE_NAME} listening on ${port}`);
  });
}
