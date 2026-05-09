import { detectWebGPUCapability } from "@opencae/solver-webgpu";
import { solveCoreDynamic, solveCoreStatic } from "@opencae/solver-cpu";
import type { SolverWorkerRequest, SolverWorkerResponse } from "./messages";

const workerSelf = self as unknown as {
  postMessage: (message: SolverWorkerResponse) => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<SolverWorkerRequest>) => void
  ) => void;
};

workerSelf.addEventListener("message", (event) => {
  void handleMessage(event.data);
});

async function handleMessage(message: SolverWorkerRequest): Promise<void> {
  try {
    if (message.type === "ping") {
      workerSelf.postMessage({
        type: "pong",
        requestId: message.requestId
      });
      return;
    }

    if (message.type === "capability-request") {
      workerSelf.postMessage({
        type: "capability-response",
        requestId: message.requestId,
        capability: await detectWebGPUCapability()
      });
      return;
    }

    if (message.type === "solve-static" || message.type === "solve-dynamic") {
      const solve =
        message.type === "solve-static"
          ? solveCoreStatic(message.model, message.options)
          : solveCoreDynamic(message.model, message.options);
      if (!solve.ok) {
        workerSelf.postMessage({
          type: "error",
          requestId: message.requestId,
          message: solve.error.message
        });
        return;
      }
      workerSelf.postMessage({
        type: "solve-response",
        requestId: message.requestId,
        result: solve.result
      });
    }
  } catch (error) {
    workerSelf.postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Unknown worker error."
    });
  }
}
