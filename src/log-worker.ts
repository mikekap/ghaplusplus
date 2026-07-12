import init, { LogParser, type LogElement } from "./wasm/ghaplusplus_wasm.js";

interface ParseMessage {
  stream: ReadableStream<Uint8Array>;
  discardFirstLine: boolean;
}

const wasmReady = init({
  module_or_path: new URL("./wasm/ghaplusplus_wasm_bg.wasm", import.meta.url),
});

self.addEventListener("message", async (event: MessageEvent<ParseMessage>) => {
  let parser: LogParser | null = null;

  try {
    await wasmReady;
    parser = new LogParser(event.data.discardFirstLine);

    const elements: LogElement[] = [];
    const reader = event.data.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      elements.push(...parser.push(value));
    }
    elements.push(...parser.finish());

    parser.free();
    parser = null;
    self.postMessage({ type: "result", elements });
  } catch (error) {
    parser?.free();
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}, { once: true });
