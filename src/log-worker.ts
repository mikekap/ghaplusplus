import init, { get_lines, type LogElement } from "./wasm/ghaplusplus_wasm.js";

type WorkerMessage =
  | { type: "init"; logUrl: string }
  | { type: "get-lines" }
  | { type: "dispose" };

interface ParsedLog {
  elements: LogElement[];
  length: number;
}

const wasmReady = init({
  module_or_path: new URL("./wasm/ghaplusplus_wasm_bg.wasm", import.meta.url),
});

let logUrl: string | null = null;
let result: Promise<ParsedLog> | null = null;
async function fetchLines(url: string): Promise<ParsedLog> {
  await wasmReady;
  return await get_lines(url) as ParsedLog;
}

self.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    if (logUrl) {
      self.postMessage({ type: "error", error: "Log worker is already initialized" });
      return;
    }
    logUrl = message.logUrl;
    wasmReady.then(
      () => self.postMessage({ type: "initialized" }),
      (error: unknown) => self.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  if (message.type === "get-lines") {
    if (!logUrl) {
      self.postMessage({ type: "error", error: "Log worker is not initialized" });
      return;
    }
    result ??= fetchLines(logUrl);
    result.then(
      ({ elements, length }) => self.postMessage({ type: "lines", elements, length }),
      (error: unknown) => self.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  self.close();
});
