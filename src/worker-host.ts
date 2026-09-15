let worker: Worker | null = null;

function handleMessage(event: MessageEvent<LogWorkerMessage>): void {
  if (event.source !== parent || event.origin !== "https://github.com") return;
  worker ??= new Worker(new URL("dist/log-worker.js", location.href), { type: "module" });
  if (event.data.type === "initialize-source" || event.data.type === "append-live") {
    console.log("[GHA++ live] worker host forwarding", JSON.stringify(event.data));
  }
  worker.postMessage(event.data, [...event.ports]);
}

window.addEventListener("message", handleMessage);
