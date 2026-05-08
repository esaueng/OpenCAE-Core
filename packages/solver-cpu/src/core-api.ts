import { solvePreviewSdofTet4Cpu } from "./dynamic-preview-sdof";
import { solveDynamicLinearTetMDOF } from "./dynamic-mdof";
import { solveStaticLinearTet } from "./solver";
import type {
  CoreDynamicSolveResult,
  CoreStaticSolveResult,
  CpuSolverInput,
  CpuSolverOptions,
  DynamicTet4CpuOptions,
  PreviewDynamicResult,
  PreviewDynamicSolveResult
} from "./types";

export function solveCoreStatic(
  model: CpuSolverInput,
  options: CpuSolverOptions = {}
): CoreStaticSolveResult {
  const result = solveStaticLinearTet(model, {
    ...options,
    method: options.method ?? options.solverMode ?? "auto"
  });
  if (!result.ok) return result;
  const coreResult = result.result.coreResult;
  if (!coreResult) {
    return {
      ok: false,
      error: {
        code: "missing-core-result",
        message: "Static solve completed without a CoreSolveResult."
      },
      diagnostics: result.diagnostics
    };
  }
  return {
    ok: true,
    result: coreResult,
    diagnostics: result.diagnostics
  };
}

export function solveCoreDynamic(
  model: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): CoreDynamicSolveResult {
  const result = solveDynamicLinearTetMDOF(model, options);
  if (!result.ok) return result;
  const coreResult = result.result.coreResult;
  if (!coreResult) {
    return {
      ok: false,
      error: {
        code: "missing-core-result",
        message: "Dynamic MDOF solve completed without a CoreSolveResult."
      },
      diagnostics: result.diagnostics
    };
  }
  return {
    ok: true,
    result: coreResult,
    diagnostics: result.diagnostics
  };
}

export function solveCorePreviewDynamic(
  model: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): PreviewDynamicSolveResult {
  const result = solvePreviewSdofTet4Cpu(model, options);
  if (!result.ok) return result;
  const provenance = result.result.staticResult.provenance ?? {
    kind: "local_estimate" as const,
    solver: "opencae-core-preview-sdof" as const,
    resultSource: "computed_preview" as const,
    meshSource: "structured_block" as const
  };
  const previewResult: PreviewDynamicResult = {
    ...result.result,
    preview: true,
    provenance
  };
  return {
    ok: true,
    result: previewResult,
    diagnostics: result.diagnostics
  };
}
