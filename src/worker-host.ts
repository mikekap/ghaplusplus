interface ParseMessage {
  stream: ReadableStream<Uint8Array>;
  discardFirstLine: boolean;
}

function handleParseRequest(event: MessageEvent<ParseMessage>): void {
  if (event.source !== parent || event.origin !== "https://github.com") return;
  window.removeEventListener("message", handleParseRequest);

  const source = event.source as Window;
  const worker = new Worker(new URL("dist/log-worker.js", location.href), {
    type: "module",
  });

  worker.addEventListener("message", (workerEvent) => {
    source.postMessage(workerEvent.data, event.origin);
    worker.terminate();
  }, { once: true });
  worker.addEventListener("error", (workerError) => {
    source.postMessage({
      type: "error",
      error: workerError.message || "Log parser worker failed",
    }, event.origin);
    worker.terminate();
  }, { once: true });

  worker.postMessage(event.data, [event.data.stream]);
}

window.addEventListener("message", handleParseRequest);
