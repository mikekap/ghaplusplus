type WorkerMessage =
  | { type: "init"; logUrl: string }
  | { type: "get-lines"; requestId: number; wrapColumns: number }
  | { type: "fetch-previous"; requestId: number; wrapColumns: number }
  | { type: "rewrap"; requestId: number; wrapColumns: number }
  | { type: "dispose" };

let worker: Worker | null = null;
let source: Window | null = null;
let sourceOrigin: string | null = null;

function reply(message: unknown): void {
  if (!source || !sourceOrigin) return;
  source.postMessage(message, sourceOrigin);
}

function handleWorkerRequest(event: MessageEvent<WorkerMessage>): void {
  if (event.source !== parent || event.origin !== "https://github.com") return;
  if (event.data.type === "init") {
    if (worker) {
      reply({ type: "error", error: "Log worker is already initialized" });
      return;
    }
    source = event.source as Window;
    sourceOrigin = event.origin;
    worker = new Worker(new URL("dist/log-worker.js", location.href), {
      type: "module",
    });
    worker.addEventListener("message", (workerEvent) => reply(workerEvent.data));
    worker.addEventListener("error", (workerError) => {
      reply({
        type: "error",
        error: workerError.message || "Log parser worker failed",
      });
    }, { once: true });
  }

  if (!worker) {
    reply({ type: "error", error: "Log worker is not initialized" });
    return;
  }

  worker.postMessage(event.data);
  if (event.data.type === "dispose") {
    worker.terminate();
    worker = null;
  }
}

window.addEventListener("message", handleWorkerRequest);
