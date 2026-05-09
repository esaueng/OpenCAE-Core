import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OPENCAE_CORE_VERSION, validateCoreResult, validateModelJson, type CoreResultValidationReport, type OpenCAEModelJson } from "@opencae/core";
import { solveCoreDynamic, solveCoreStatic, type CpuSolverOptions, type DynamicTet4CpuOptions } from "@opencae/solver-cpu";

export const RUNNER_VERSION = "0.1.0";
export const SOLVER_CPU_VERSION = "0.1.0";
export const SERVICE_NAME = "opencae-core-cloud";

export type CloudAnalysisType = "static_stress" | "dynamic_structural";

export type CloudSolveRequest = {
  runId?: string;
  analysisType: CloudAnalysisType;
  coreModel: OpenCAEModelJson;
  solverSettings?: (CpuSolverOptions & DynamicTet4CpuOptions & { allowPreview?: boolean }) | undefined;
  resultSettings?: Record<string, unknown>;
};

export type CloudResponse = {
  status: number;
  body: unknown;
};

export function healthResponse(): CloudResponse {
  return {
    status: 200,
    body: {
      ok: true,
      service: SERVICE_NAME,
      runnerVersion: RUNNER_VERSION,
      coreVersion: OPENCAE_CORE_VERSION,
      solverCpuVersion: SOLVER_CPU_VERSION,
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolvers: ["sparse_static", "mdof_dynamic"],
      supportsActualVolumeMesh: true,
      supportsPreview: false,
      noCalculix: true,
      noLocalEstimateFallback: true
    }
  };
}

export function solveResponse(request: unknown): CloudResponse {
  if (!isSolveRequest(request)) {
    return errorResponse(400, "invalid-request", "Request must include analysisType and coreModel.");
  }
  if (request.solverSettings?.allowPreview) {
    return errorResponse(400, "preview-disabled", "OpenCAE Core Cloud does not allow preview solvers.");
  }

  const validation = validateModelJson(request.coreModel);
  if (!validation.ok) {
    return {
      status: 422,
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
      ? solveCoreStatic(request.coreModel, { ...request.solverSettings, method: request.solverSettings?.method ?? "sparse" })
      : solveCoreDynamic(request.coreModel, request.solverSettings);

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

  const resultValidation = validateCoreResult(result.result);
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
    body: result.result
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
      sendJson(response, healthResponse());
      return;
    }
    if (request.method === "POST" && request.url === "/solve") {
      try {
        sendJson(response, solveResponse(JSON.parse(await readBody(request))));
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
  return (
    (request.analysisType === "static_stress" || request.analysisType === "dynamic_structural") &&
    !!request.coreModel &&
    typeof request.coreModel === "object"
  );
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

if (process.env.NODE_ENV !== "test" && process.argv[1]?.endsWith("server.js")) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createCoreCloudServer().listen(port, () => {
    console.log(`${SERVICE_NAME} listening on ${port}`);
  });
}
