import type { WebGPUCapability } from "@opencae/solver-webgpu";

export type SolverWorkerRequest =
  | {
      type: "ping";
      requestId: string;
    }
  | {
      type: "capability-request";
      requestId: string;
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
      type: "error";
      requestId: string;
      message: string;
    };
