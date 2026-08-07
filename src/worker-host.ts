let worker: Worker | null = null;

function handleMessage(event: MessageEvent<CreateLogViewMessage>): void {
  if (event.source !== parent || event.origin !== "https://github.com") return;
  worker ??= new Worker(new URL("dist/log-worker.js", location.href), { type: "module" });
  worker.postMessage(event.data, [...event.ports]);
}

window.addEventListener("message", handleMessage);
