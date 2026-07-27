import init, { LogSession } from "./wasm/ghaplusplus_wasm.js";

type WorkerMessage =
  | { type: "init"; logUrl: string }
  | { type: "get-lines"; requestId: number; wrapColumns: number }
  | { type: "fetch-previous"; requestId: number; wrapColumns: number }
  | { type: "rewrap"; requestId: number; wrapColumns: number }
  | { type: "dispose" };

interface ParsedLog {
  chunks: Array<{ html: string; rows: number; estimatedHeight: number }>;
  length: number;
  complete: boolean;
  wrapColumns: number;
}

const wasmReady = init({
  module_or_path: new URL("./wasm/ghaplusplus_wasm_bg.wasm", import.meta.url),
});

let logUrl: string | null = null;
let session: LogSession | null = null;
let result: Promise<ParsedLog> | null = null;
async function fetchLines(url: string, wrapColumns: number): Promise<ParsedLog> {
  await wasmReady;
  session ??= new LogSession(url);
  return await session.fetch(wrapColumns) as ParsedLog;
}

async function rewrap(wrapColumns: number): Promise<ParsedLog> {
  await result;
  if (!session) throw new Error("Log worker has not fetched a range");
  return session.rewrap(wrapColumns) as ParsedLog;
}

async function fetchPrevious(wrapColumns: number): Promise<ParsedLog> {
  await result;
  if (!session) throw new Error("Log worker has not fetched a range");
  result = session.fetch_previous(wrapColumns) as Promise<ParsedLog>;
  return result;
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
    result ??= fetchLines(logUrl, message.wrapColumns);
    result.then(
      ({ chunks, length, complete, wrapColumns }) => self.postMessage({
        type: "lines",
        requestId: message.requestId,
        chunks,
        length,
        complete,
        wrapColumns,
      }),
      (error: unknown) => self.postMessage({
        type: "error",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  if (message.type === "rewrap") {
    rewrap(message.wrapColumns).then(
      ({ chunks, length, complete, wrapColumns }) => self.postMessage({
        type: "lines",
        requestId: message.requestId,
        chunks,
        length,
        complete,
        wrapColumns,
      }),
      (error: unknown) => self.postMessage({
        type: "error",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  if (message.type === "fetch-previous") {
    fetchPrevious(message.wrapColumns).then(
      ({ chunks, length, complete, wrapColumns }) => self.postMessage({
        type: "lines",
        requestId: message.requestId,
        chunks,
        length,
        complete,
        wrapColumns,
      }),
      (error: unknown) => self.postMessage({
        type: "error",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  self.close();
});
