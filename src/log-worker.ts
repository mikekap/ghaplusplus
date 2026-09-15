import init, { LogSource, LogView } from "./wasm/ghaplusplus_wasm.js";

const wasmReady = init({
  module_or_path: new URL("./wasm/ghaplusplus_wasm_bg.wasm", import.meta.url),
});

let sourceReady: Promise<LogSource> | null = null;
let initialFetch: Promise<void> | null = null;
let previousFetch: Promise<void> | null = null;
let waitingForLiveOutput = false;
const activeViews = new Set<{
  renderLive: () => void;
  reportError: (error: unknown) => void;
}>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameChunk(left: RenderedChunk, right: RenderedChunk): boolean {
  return left.html === right.html
    && left.rows === right.rows
    && left.estimatedHeight === right.estimatedHeight;
}

function changedChunks(previous: RenderedChunk[], next: RenderedChunk[]): RenderSplice {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && sameChunk(previous[prefix], next[prefix])) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && sameChunk(previous[previous.length - suffix - 1], next[next.length - suffix - 1])
  ) suffix += 1;

  return {
    index: prefix,
    deleteCount: previous.length - prefix - suffix,
    chunks: next.slice(prefix, next.length - suffix),
  };
}

function resolveSource(step: GitHubJobStep, stepsUrl: string): { url: string; backscroll: boolean } {
  if (["queued", "requested", "pending", "waiting", "in_progress"].includes(step.status ?? "")) {
    if (!step.id) throw new Error("Live log step has no ID");
    const url = new URL(stepsUrl);
    if (!/\/actions\/runs\/\d+\/jobs\/\d+\/steps\/?$/.test(url.pathname)) {
      throw new Error("Unable to determine the running log endpoint from the steps URL");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(step.id)}/backscroll`;
    url.search = "";
    url.hash = "";
    return { url: url.href, backscroll: true };
  }
  if (!step.log_url) throw new Error("Completed log step has no log URL");
  return { url: new URL(step.log_url, new URL("/", stepsUrl)).href, backscroll: false };
}

function initializeSource(step: GitHubJobStep, stepsUrl: string): void {
  waitingForLiveOutput = ["queued", "requested", "pending", "waiting"].includes(step.status ?? "");
  console.log("[GHA++ live] log worker initialized", JSON.stringify({
    step,
    stepsUrl,
    waitingForLiveOutput,
  }));
  sourceReady ??= wasmReady.then(() => {
    const source = resolveSource(step, stepsUrl);
    return new LogSource(source.url, source.backscroll);
  });
}

function appendLive(event: GitHubLiveLogEvent): void {
  console.log("[GHA++ live] log worker received step log", JSON.stringify(event));
  const ready = sourceReady ?? Promise.reject(new Error("Log worker source was not initialized"));
  void ready.then(async (source) => {
    await loadSource(source);
    const changed = source.append_live(event);
    console.log("[GHA++ live] Rust append complete", {
      stepId: event.stepId,
      changed,
      activeViews: activeViews.size,
    });
    if (changed) {
      activeViews.forEach((view) => view.renderLive());
    }
  })
    .catch((error: unknown) => {
      console.error("[GHA++ live] append failed", error);
      activeViews.forEach((view) => view.reportError(error));
    });
}

function loadSource(source: LogSource): Promise<void> {
  initialFetch ??= waitingForLiveOutput ? Promise.resolve() : source.fetch();
  return initialFetch;
}

function fetchPreviousSource(source: LogSource): Promise<void> {
  if (previousFetch) return previousFetch;
  previousFetch = loadSource(source)
    .then(() => source.fetch_previous())
    .finally(() => { previousFetch = null; });
  return previousFetch;
}

function createView(source: LogSource, port: MessagePort, wrapColumns: number): void {
  const view: LogView = source.create_view(wrapColumns);
  let closed = false;
  let loaded = false;
  let renderTimer: number | undefined;
  let pendingRender: RenderedLog | null = null;
  let renderedChunks: RenderedChunk[] = [];
  let revision = 0;

  const postError = (error: unknown): void => {
    if (!closed) port.postMessage({ type: "error", message: errorMessage(error) } satisfies LogViewEvent);
  };
  const render = (log: unknown): void => {
    pendingRender = log as RenderedLog;
    if (renderTimer !== undefined) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      if (closed || !pendingRender) return;
      const log = pendingRender;
      pendingRender = null;
      const splice = changedChunks(renderedChunks, log.chunks);
      renderedChunks = log.chunks;
      revision += 1;
      port.postMessage({
        type: "render",
        revision,
        splice,
        complete: log.complete,
        wrapColumns: log.wrapColumns,
      } satisfies LogViewEvent);
    }, 8);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (renderTimer !== undefined) clearTimeout(renderTimer);
    port.onmessage = null;
    port.removeEventListener("close", close);
    activeViews.delete(activeView);
    view.free();
  };

  const activeView = {
    renderLive: (): void => {
      if (loaded) render(view.render_current());
    },
    reportError: postError,
  };
  activeViews.add(activeView);

  port.onmessage = (event: MessageEvent<LogViewCommand>): void => {
    const command = event.data;
    if (command.type === "load") {
      void loadSource(source).then(() => {
        loaded = true;
        return view.initialize_window();
      }).then(render, postError);
    } else if (command.type === "fetch-previous") {
      void fetchPreviousSource(source).then(() => view.expand_to_source_start()).then(render, postError);
    } else if (command.type === "set-wrap-columns") {
      try {
        render(view.set_wrap_columns(command.wrapColumns));
      } catch (error) {
        postError(error);
      }
    }
  };
  port.addEventListener("close", close);
  port.start();
}

self.addEventListener("message", (event: MessageEvent<LogWorkerMessage>) => {
  const message = event.data;
  if (message.type === "initialize-source") {
    initializeSource(message.step, message.stepsUrl);
    return;
  }
  if (message.type === "append-live") {
    appendLive(message.event);
    return;
  }
  const port = event.ports[0];
  if (!port) return;
  const source = sourceReady ?? Promise.reject(new Error("Log worker source was not initialized"));
  void source.then(
    (source) => createView(source, port, message.wrapColumns),
    (error: unknown) => {
      port.postMessage({ type: "error", message: errorMessage(error) } satisfies LogViewEvent);
      port.close();
    },
  );
});
