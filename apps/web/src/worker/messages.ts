import type { WebGPUCapability } from "@opencae/solver-webgpu";
import type { CoreSolveResult, OpenCAEModelJson } from "@opencae/core";
import type { CpuSolverOptions, DynamicTet4CpuOptions } from "@opencae/solver-cpu";

export type SolverWorkerRequest =
  | {
      type: "ping";
      requestId: string;
    }
  | {
      type: "capability-request";
      requestId: string;
    }
  | {
      type: "solve-static";
      requestId: string;
      model: OpenCAEModelJson;
      options?: CpuSolverOptions;
    }
  | {
      type: "solve-dynamic";
      requestId: string;
      model: OpenCAEModelJson;
      options?: DynamicTet4CpuOptions;
    };

export type SolverWorkerResponse =
  | {
      type: "pong";
      requestId: string;
    }
  | {
      type: "capability-response";
      requestId: string;
      capability: WebGPUCapability;
    }
  | {
      type: "solve-response";
      requestId: string;
      result: CoreSolveResult;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
    };
