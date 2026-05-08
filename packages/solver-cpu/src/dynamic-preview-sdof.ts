import { solveDynamicMdofTet4Cpu } from "./dynamic-mdof";
import type { CpuSolverInput, DynamicTet4CpuOptions, DynamicTet4CpuSolveResult } from "./types";

export function solvePreviewSdofTet4Cpu(
  input: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): DynamicTet4CpuSolveResult {
  const result = solveDynamicMdofTet4Cpu(input, options);
  if (!result.ok) return result;
  return {
    ...result,
    result: {
      ...result.result,
      staticResult: {
        ...result.result.staticResult,
        provenance: {
          kind: "local_estimate",
          solver: "opencae-core-preview-sdof",
          resultSource: "computed_preview",
          meshSource: "structured_block"
        }
      }
    }
  };
}
