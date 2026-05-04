import { detectWebGPUCapability } from "@opencae/solver-webgpu";
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
    }
  } catch (error) {
    workerSelf.postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Unknown worker error."
    });
  }
}
