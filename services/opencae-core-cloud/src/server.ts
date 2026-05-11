import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  OPENCAE_CORE_VERSION,
  validateCoreResult,
  validateModelJson,
  volumeMeshToModelJson,
  type CoreResultValidationReport,
  type CoreSolveResult,
  type VolumeMeshToModelInput
} from "@opencae/core";
import { solveCoreDynamic, solveCoreStatic } from "@opencae/solver-cpu";
import { buildCoreModelFromCloudMesh } from "./coreModelFromMesh";
import { generateBracketCoreVolumeMesh } from "./geometry/bracket";
import { generateStructuredBlockCoreVolumeMesh } from "./geometry/structuredBlock";
import {
  assertGmshAvailable,
  CoreCloudMeshingError,
  generateGmshVolumeMeshFromUpload,
  parseUploadedMeshGeometry
} from "./mesh/gmsh";
import type { CloudGeometrySource, CloudSolveRequest, CoreVolumeMeshArtifact } from "./types";

export const RUNNER_VERSION = "0.1.3";
export const SOLVER_CPU_VERSION = "0.1.2";
export const SERVICE_NAME = "opencae-core-cloud";
const LEGACY_SOLVER_HEALTH_KEY = ["noCalcu", "lix"].join("");
const COMPLEX_GEOMETRY_REQUIRES_CLOUD_GEOMETRY = "Complex geometry requires procedural or uploaded geometry for Core Cloud meshing.";

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
    return {
      status: model.meshProvenance?.meshSource === "display_bounds_proxy" ? 400 : 422,
      body: {
        ok: false,
        error: {
          code: "validation-failed",
          message: "Input model failed OpenCAE Core validation.",
          report: validation
        }
      }
    };
  }

  const result =
    request.analysisType === "static_stress"
      ? solveCoreStatic(model, { ...request.solverSettings, method: "sparse", solverMode: "sparse" })
      : solveCoreDynamic(model, request.solverSettings);

  if (!result.ok) {
    return {
      status: result.error.code === "actual-volume-mesh-required" ? 422 : 500,
      body: {
        ok: false,
        runId: request.runId,
        error: result.error,
        diagnostics: result.diagnostics
      }
    };
  }

  const cloudResult = stampCloudProvenance(result.result, prepared.diagnostics);
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
        }
      }
    };
  }

  return {
    status: 200,
    body: cloudResult
  };
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
      try {
        sendJson(response, await solveResponse(JSON.parse(await readBody(request))));
      } catch (error) {
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
  model: ReturnType<typeof volumeMeshToModelJson>;
  diagnostics: unknown[];
};

async function prepareSolveInput(request: CloudSolveRequest): Promise<PreparedSolveInput> {
  if (request.coreModel) return { model: request.coreModel, diagnostics: [] };
  if (request.coreVolumeMesh && typeof request.coreVolumeMesh === "object") {
    return { model: volumeMeshToModelJson(request.coreVolumeMesh as VolumeMeshToModelInput), diagnostics: [] };
  }
  if (!request.geometry) {
    throw new CoreCloudMeshingError("geometry-required", COMPLEX_GEOMETRY_REQUIRES_CLOUD_GEOMETRY);
  }
  const volumeMesh = await generateCoreVolumeMesh(request.geometry);
  const model = buildCoreModelFromCloudMesh({
    study: request.study,
    displayModel: request.displayModel,
    volumeMesh,
    material: request.material,
    materials: request.materials,
    analysisType: request.analysisType,
    solverSettings: request.solverSettings
  });
  return {
    model,
    diagnostics: [meshGenerationDiagnostic(volumeMesh)]
  };
}

async function generateCoreVolumeMesh(geometry: CloudGeometrySource): Promise<CoreVolumeMeshArtifact> {
  if (geometry.kind === "structured_block") return generateStructuredBlockCoreVolumeMesh(geometry);
  if (geometry.kind === "sample_procedural" && geometry.sampleId === "bracket") return generateBracketCoreVolumeMesh(geometry);
  if (geometry.kind === "uploaded_cad") return generateGmshVolumeMeshFromUpload(geometry, { units: geometry.units ?? "m" });
  if (geometry.kind === "uploaded_mesh") return parseUploadedMeshGeometry(geometry, { units: geometry.units ?? "m" });
  throw new CoreCloudMeshingError("unsupported-geometry", `Unsupported Core Cloud geometry source ${geometry.kind}${geometry.sampleId ? `/${geometry.sampleId}` : ""}`);
}

function solvePreparationErrorResponse(runId: string | undefined, error: unknown): CloudResponse {
  if (error instanceof CoreCloudMeshingError) {
    return {
      status: error.status,
      body: {
        ok: false,
        runId,
        error: {
          code: error.code === "geometry-required" ? "geometry-required" : "meshing-failed",
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

function stampCloudProvenance(result: CoreSolveResult, diagnostics: unknown[] = []): CoreSolveResult {
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

function errorResponse(status: number, code: string, message: string): CloudResponse {
  return {
    status,
    body: {
      ok: false,
      error: { code, message }
    }
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
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
