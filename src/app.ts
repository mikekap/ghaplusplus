(() => {
  "use strict";

  interface JobStep {
    id?: string;
    log_url: string | null;
    name?: string;
    number?: number;
    status?: string | null;
    conclusion?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    getLines?: () => Promise<ParsedLog>;
    fetchPrevious?: (wrapColumns: number) => Promise<ParsedLog>;
    rewrap?: (wrapColumns: number) => Promise<ParsedLog>;
  }

  interface ParsedLog {
    chunks: Array<{ html: string; rows: number; estimatedHeight: number }>;
    length: number;
    complete: boolean;
    wrapColumns: number;
  }

  interface StepLogWorkerHandle {
    getLines(wrapColumns: number): Promise<ParsedLog>;
    fetchPrevious(wrapColumns: number): Promise<ParsedLog>;
    rewrap(wrapColumns: number): Promise<ParsedLog>;
    dispose(): void;
  }

  interface GHAPlusPlusRuntime {
    createStepLogWorker(logUrl: string): Promise<StepLogWorkerHandle>;
  }

  interface GHAPlusPlusReactApp {
    mount(
      container: HTMLElement,
      stepsUrl: string,
      onInitialLogsComplete: () => void,
      onRawLogsUrl: (url: string | null) => void,
    ): void;
    unmount(host: HTMLElement): void;
  }

  type ExtensionGlobal = typeof globalThis & {
    GHAPlusPlusRuntime?: GHAPlusPlusRuntime;
    GHAPlusPlusReactApp?: GHAPlusPlusReactApp;
  };
  const extensionGlobal = globalThis as ExtensionGlobal;
  const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>();
  const chunkDebugObservers = new WeakMap<HTMLDivElement, IntersectionObserver>();
  const stickyToolbarDisposers = new WeakMap<HTMLElement, () => void>();

  function keepStepHeadersBelowToolbar(host: HTMLElement): () => void {
    let frame = 0;
    let toolbar: HTMLElement | null = null;
    let toolbarObserver: ResizeObserver | null = null;

    const update = (): void => {
      frame = 0;
      const nextToolbar = document.querySelector<HTMLElement>(".js-checks-log-toolbar");
      if (nextToolbar !== toolbar) {
        toolbarObserver?.disconnect();
        toolbar = nextToolbar;
        if (toolbar) {
          toolbar.style.setProperty("z-index", "2");
          toolbarObserver = new ResizeObserver(schedule);
          toolbarObserver.observe(toolbar);
        } else {
          toolbarObserver = null;
        }
      }
      const offset = toolbar ? Math.max(0, Math.round(toolbar.getBoundingClientRect().bottom)) : 0;
      host.style.setProperty("--gha-step-sticky-top", `${offset}px`);
    };

    const schedule = (): void => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return (): void => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      toolbarObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }

  function measureWrapColumns(host: HTMLElement, shadow: ShadowRoot): number {
    if (host.clientWidth === 0) return 120;
    const probe = document.createElement("span");
    probe.textContent = "0000000000";
    probe.style.cssText = "font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; position: absolute; visibility: hidden; white-space: pre;";
    shadow.append(probe);
    const characterWidth = probe.getBoundingClientRect().width / 10;
    probe.remove();
    if (!Number.isFinite(characterWidth) || characterWidth <= 0) return 120;
    // Reserve the fixed line-number gutter plus horizontal padding.
    return Math.max(40, Math.floor((host.clientWidth - characterWidth * 12 - 24) / characterWidth));
  }

  type FetchPriority = "interactive" | "initial" | "background";

  interface ScheduledLogFetch {
    load: () => Promise<ParsedLog>;
    priority: FetchPriority;
    initial: boolean;
    started: boolean;
    promise: Promise<ParsedLog>;
    resolve: (log: ParsedLog) => void;
    reject: (error: Error) => void;
  }

  /** Bounded queue shared by initial, background, and interactive log work. */
  class LogFetchPrioritizer {
    private readonly queues: Record<FetchPriority, ScheduledLogFetch[]> = {
      interactive: [],
      initial: [],
      background: [],
    };
    private active = 0;
    private pendingInitial = 0;
    private initialBatchClosed = false;
    private initialCompletionNotified = false;
    private cancelled = false;

    constructor(
      private readonly concurrency = 2,
      private readonly onInitialLogsComplete: () => void = () => undefined,
    ) {}

    scheduleInitial(load: () => Promise<ParsedLog>): ScheduledLogFetch {
      this.pendingInitial += 1;
      return this.schedule(load, "initial", true);
    }

    scheduleBackground(load: () => Promise<ParsedLog>): ScheduledLogFetch {
      return this.schedule(load, "background", false);
    }

    closeInitialBatch(): void {
      this.initialBatchClosed = true;
      this.notifyInitialCompletion();
      this.drain();
    }

    request(task: ScheduledLogFetch): Promise<ParsedLog> {
      if (!task.started && task.priority === "background") {
        this.remove(task);
        task.priority = "interactive";
        this.queues.interactive.push(task);
      }
      this.drain();
      return task.promise;
    }

    cancel(): void {
      this.cancelled = true;
      for (const priority of Object.keys(this.queues) as FetchPriority[]) {
        this.queues[priority].forEach((task) => {
          task.reject(new Error("Log fetch prioritizer was cancelled"));
        });
        this.queues[priority] = [];
      }
    }

    private schedule(
      load: () => Promise<ParsedLog>,
      priority: FetchPriority,
      initial: boolean,
    ): ScheduledLogFetch {
      let resolve!: (log: ParsedLog) => void;
      let reject!: (error: Error) => void;
      const task: ScheduledLogFetch = {
        load,
        priority,
        initial,
        started: false,
        promise: new Promise<ParsedLog>((nextResolve, nextReject) => {
          resolve = nextResolve;
          reject = nextReject;
        }),
        resolve,
        reject,
      };
      this.queues[priority].push(task);
      void task.promise.catch(() => undefined);
      this.drain();
      return task;
    }

    private next(): ScheduledLogFetch | undefined {
      return this.queues.interactive.shift()
        ?? this.queues.initial.shift()
        ?? (this.initialBatchClosed && this.pendingInitial === 0
          ? this.queues.background.shift()
          : undefined);
    }

    private drain(): void {
      while (!this.cancelled && this.active < this.concurrency) {
        const task = this.next();
        if (!task) return;

        task.started = true;
        this.active += 1;
        void Promise.resolve().then(task.load).then(task.resolve, task.reject).finally(() => {
          this.active -= 1;
          if (task.initial) this.pendingInitial -= 1;
          this.notifyInitialCompletion();
          this.drain();
        });
      }
    }

    private remove(task: ScheduledLogFetch): void {
      const queue = this.queues[task.priority];
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
    }

    private notifyInitialCompletion(): void {
      if (
        this.cancelled
        || !this.initialBatchClosed
        || this.pendingInitial !== 0
        || this.initialCompletionNotified
      ) return;
      this.initialCompletionNotified = true;
      this.onInitialLogsComplete();
    }
  }

  function isCollapsedByDefault(step: JobStep): boolean {
    return step.status === "completed" && step.conclusion === "success";
  }

  function stepDuration(step: JobStep): string | null {
    if (!step.started_at || !step.completed_at) return null;
    const startedAt = Date.parse(step.started_at);
    const completedAt = Date.parse(step.completed_at);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return null;
    let seconds = Math.round((completedAt - startedAt) / 1_000);
    const hours = Math.floor(seconds / 3_600);
    seconds %= 3_600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;
    const parts: string[] = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes || hours) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(" ");
  }

  interface StepPresentation {
    icon: string;
    label: string;
    message?: string;
    kind: "success" | "failure" | "cancelled" | "queued" | "in-progress" | "skipped" | "not-run" | "neutral";
  }

  function stepPresentation(step: JobStep): StepPresentation {
    if (["queued", "requested", "pending", "waiting"].includes(step.status ?? "")) {
      return { icon: "◌", label: "Queued", message: "Queued — GitHub has not created a log for this step yet.", kind: "queued" };
    }
    if (step.status === "in_progress") {
      return { icon: "◐", label: "In progress", message: "In progress — live log retrieval is not implemented yet.", kind: "in-progress" };
    }
    switch (step.conclusion) {
      case "success":
        return { icon: "✅", label: "Succeeded", kind: "success" };
      case "failure":
      case "startup_failure":
        return { icon: "❌", label: "Failed", kind: "failure" };
      case "cancelled":
      case "timed_out":
        return { icon: "🛑", label: "Cancelled", kind: "cancelled" };
      case "skipped":
        return { icon: "⏭️", label: "Skipped", message: "Skipped — GitHub did not provide a log for this step.", kind: "skipped" };
      case "neutral":
        return { icon: "⚪", label: "Neutral", kind: "neutral" };
    }
    return { icon: "⊘", label: "Not run", message: "Not run — GitHub did not provide a log for this step.", kind: "not-run" };
  }

  function writeLogChunks(container: HTMLDivElement, log: ParsedLog): void {
    chunkDebugObservers.get(container)?.disconnect();
    const fragment = document.createDocumentFragment();
    log.chunks.forEach((chunk, index) => {
      const chunkElement = document.createElement("div");
      chunkElement.className = "gha-log-chunk";
      chunkElement.style.containIntrinsicSize = `auto ${chunk.estimatedHeight}px`;
      chunkElement.dataset.ghaChunkIndex = String(index);
      chunkElement.dataset.ghaEstimatedHeight = String(chunk.estimatedHeight);
      chunkElement.innerHTML = chunk.html;
      fragment.append(chunkElement);
    });
    container.className = `gha-log ${log.complete ? "gha-log--complete" : "gha-log--partial"}`;
    container.style.counterReset = "";
    container.replaceChildren(fragment);

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const chunk = entry.target as HTMLElement;
        observer.unobserve(chunk);
        requestAnimationFrame(() => {
          const estimated = Number(chunk.dataset.ghaEstimatedHeight);
          const actual = chunk.getBoundingClientRect().height;
          console.debug("[GHA++] log chunk height", {
            chunk: Number(chunk.dataset.ghaChunkIndex),
            estimated,
            actual,
            delta: actual - estimated,
            ratio: estimated === 0 ? null : actual / estimated,
          });
        });
      });
    });
    container.querySelectorAll<HTMLElement>(".gha-log-chunk").forEach((chunk) => observer.observe(chunk));
    chunkDebugObservers.set(container, observer);
  }

  function StepLogView({
    step,
    index,
    wrapColumns,
    onInitialLogRendered,
  }: {
    step: JobStep;
    index: number;
    wrapColumns: number;
    onInitialLogRendered?: () => void;
  }) {
    type State =
      | { status: "loading" }
      | { status: "ready"; log: ParsedLog }
      | { status: "error"; message: string };

    const [state, setState] = React.useState<State>({ status: "loading" });
    const [collapsed, setCollapsed] = React.useState(() => isCollapsedByDefault(step));
    const [fetchingPrevious, setFetchingPrevious] = React.useState(false);
    const logContainer = React.useRef<HTMLDivElement>(null);
    const section = React.useRef<HTMLElement>(null);
    const initialLogRendered = React.useRef(false);

    React.useEffect(() => {
      let cancelled = false;
      if (collapsed || !step.log_url || !step.getLines) return undefined;
      step.getLines().then(
        (log) => { if (!cancelled) setState({ status: "ready", log }); },
        (error: unknown) => {
          if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        },
      );
      return () => { cancelled = true; };
    }, [collapsed, step]);

    React.useLayoutEffect(() => {
      if (state.status === "ready" && logContainer.current) {
        writeLogChunks(logContainer.current, state.log);
      }
      if (
        onInitialLogRendered
        && !initialLogRendered.current
        && (state.status === "ready" || state.status === "error")
      ) {
        initialLogRendered.current = true;
        onInitialLogRendered();
      }
    }, [onInitialLogRendered, state]);

    React.useEffect(() => {
      if (
        collapsed
        || state.status !== "ready"
        || !step.rewrap
        || state.log.wrapColumns === wrapColumns
      ) return;
      let cancelled = false;
      step.rewrap(wrapColumns).then(
        (log) => { if (!cancelled) setState({ status: "ready", log }); },
        (error: unknown) => {
          if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        },
      );
      return () => { cancelled = true; };
    }, [collapsed, state, step, wrapColumns]);

    const title = step.name || `Step ${step.number ?? index + 1}`;
    const duration = stepDuration(step);
    const presentation = stepPresentation(step);
    const skipped = presentation.kind === "skipped";
    const logless = step.log_url ? null : presentation;
    const scrollToStep = (position: "start" | "end"): void => {
      const target = section.current;
      if (!target) return;
      const options = { block: position, inline: "nearest", behavior: "instant" as ScrollBehavior } as const;
      target.scrollIntoView(options);
    };
    const fetchPrevious = (): void => {
      if (fetchingPrevious || state.status !== "ready" || state.log.complete || !step.fetchPrevious) return;
      setFetchingPrevious(true);
      step.fetchPrevious(wrapColumns).then(
        (log) => setState({ status: "ready", log }),
        (error: unknown) => console.error("[GHA++] Failed to fetch previous log range", error),
      ).finally(() => setFetchingPrevious(false));
    };
    let content: React.ReactNode = null;
    if (!collapsed && !skipped) {
      if (logless) content = React.createElement("div", { className: "gha-log-status gha-muted" }, logless.message);
      else if (!step.getLines) content = React.createElement("div", { className: "gha-log-status gha-muted" }, "Preparing log…");
      else if (state.status === "loading") content = React.createElement("div", { className: "gha-log-status gha-muted" }, "Loading log…");
      else if (state.status === "error") content = React.createElement("div", { className: "gha-log-status gha-error" }, state.message);
      else content = React.createElement("div", { ref: logContainer });
    }

    return React.createElement(
      "section",
      { ref: section, className: `gha-step${logless ? ` gha-step--no-log gha-step--${presentation.kind}` : ""}` },
      React.createElement(
        "div",
        { className: "gha-step-title" },
        skipped
          ? React.createElement(
            "div",
            { className: "gha-step-static" },
            React.createElement("span", { className: "gha-step-icon", role: "img", "aria-label": presentation.label }, presentation.icon),
            title,
            duration && React.createElement("span", { className: "gha-step-duration" }, duration),
          )
          : React.createElement(
            "button",
            { className: "gha-step-toggle", type: "button", "aria-expanded": !collapsed, onClick: () => setCollapsed((value) => !value) },
            React.createElement("span", { className: "gha-step-chevron", "aria-hidden": true }, collapsed ? "▸" : "▾"),
            React.createElement("span", { className: "gha-step-icon", role: "img", "aria-label": presentation.label }, presentation.icon),
            title,
            duration && React.createElement("span", { className: "gha-step-duration" }, duration),
          ),
        !skipped && React.createElement(
          "span",
          { className: "gha-step-navigation" },
          state.status === "ready" && !state.log.complete && step.fetchPrevious && React.createElement("button", {
            className: "gha-step-navigation-link gha-step-navigation-button",
            type: "button",
            disabled: fetchingPrevious,
            title: "Fetch the previous 2 MiB of this log",
            onClick: fetchPrevious,
          }, fetchingPrevious ? "Loading…" : "↑ Prev"),
          React.createElement("a", {
            className: "gha-step-navigation-link",
            href: "#",
            onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              scrollToStep("start");
            },
          }, "↑ Top"),
          React.createElement("a", {
            className: "gha-step-navigation-link",
            href: "#",
            onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              scrollToStep("end");
            },
          }, "↓ End"),
        ),
      ),
      content,
    );
  }

  function JobLogApp({
    stepsUrl,
    onInitialLogsComplete,
    onRawLogsUrl,
    wrapColumns,
  }: {
    stepsUrl: string;
    onInitialLogsComplete: () => void;
    onRawLogsUrl: (url: string | null) => void;
    wrapColumns: number;
  }) {
    type State =
      | { status: "loading" }
      | { status: "ready"; steps: JobStep[] }
      | { status: "error"; message: string };
    const [state, setState] = React.useState<State>({ status: "loading" });
    const [initialFetchesComplete, setInitialFetchesComplete] = React.useState(false);
    const [initialLogsRendered, setInitialLogsRendered] = React.useState(0);
    const initialLogsReported = React.useRef(false);
    const wrapColumnsRef = React.useRef(wrapColumns);
    wrapColumnsRef.current = wrapColumns;
    const reportInitialLogRendered = React.useCallback(() => {
      setInitialLogsRendered((count) => count + 1);
    }, []);

    React.useLayoutEffect(() => {
      const initialLogCount = state.status === "ready"
        ? state.steps.filter((step) => Boolean(step.log_url) && !isCollapsedByDefault(step)).length
        : 0;
      const ready = state.status === "error"
        || (state.status === "ready" && initialFetchesComplete && initialLogsRendered >= initialLogCount);
      if (!ready || initialLogsReported.current) return undefined;
      const frame = window.requestAnimationFrame(() => {
        if (initialLogsReported.current) return;
        initialLogsReported.current = true;
        onInitialLogsComplete();
      });
      return () => window.cancelAnimationFrame(frame);
    }, [initialFetchesComplete, initialLogsRendered, onInitialLogsComplete, state]);

    React.useEffect(() => {
      let cancelled = false;
      const workers = new Set<StepLogWorkerHandle>();
      let initialFetchesReported = false;
      const reportInitialFetchesComplete = (): void => {
        if (cancelled || initialFetchesReported) return;
        initialFetchesReported = true;
        setInitialFetchesComplete(true);
      };
      const prioritizer = new LogFetchPrioritizer(2, reportInitialFetchesComplete);

      async function loadSteps(): Promise<void> {
        setState({ status: "loading" });
        const stepsRequest = await fetch(stepsUrl, { headers: { Accept: "application/json" } });
        if (!stepsRequest.ok) throw new Error(`Steps request failed with HTTP ${stepsRequest.status}`);
        const runtime = extensionGlobal.GHAPlusPlusRuntime;
        if (!runtime) throw new Error("GHA++ worker runtime is unavailable");

        const rawSteps = await stepsRequest.json() as JobStep[];
        const stepLogUrl = rawSteps.find((step) => step.log_url)?.log_url;
        let rawLogsUrl: string | null = null;
        if (stepLogUrl) {
          const url = new URL(stepLogUrl, location.origin);
          const rawLogsPath = url.pathname.replace(/\/logs\/\d+\/?$/, "/logs");
          if (rawLogsPath !== url.pathname) {
            url.pathname = rawLogsPath;
            url.search = "";
            url.hash = "";
            rawLogsUrl = url.href;
          }
        }
        onRawLogsUrl(rawLogsUrl);
        const steps = rawSteps.map((step) => {
          if (!step.log_url) return step;
          let worker: StepLogWorkerHandle | null = null;
          const load = async (): Promise<ParsedLog> => {
            worker ??= await runtime.createStepLogWorker(new URL(step.log_url!, location.origin).href);
            if (cancelled) {
              worker.dispose();
              throw new Error("Job log app was unmounted");
            }
            workers.add(worker);
            return worker.getLines(wrapColumnsRef.current);
          };
          const task = isCollapsedByDefault(step)
            ? prioritizer.scheduleBackground(load)
            : prioritizer.scheduleInitial(load);
          return {
            ...step,
            getLines: () => prioritizer.request(task),
            fetchPrevious: async (columns: number): Promise<ParsedLog> => {
              await prioritizer.request(task);
              if (!worker) throw new Error("Log worker was not initialized");
              return worker.fetchPrevious(columns);
            },
            rewrap: async (columns: number): Promise<ParsedLog> => {
              await prioritizer.request(task);
              if (!worker) throw new Error("Log worker was not initialized");
              return worker.rewrap(columns);
            },
          };
        });
        prioritizer.closeInitialBatch();
        if (!cancelled) setState({ status: "ready", steps });
      }

      loadSteps().catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        reportInitialFetchesComplete();
      });
      return () => {
        cancelled = true;
        prioritizer.cancel();
        workers.forEach((worker) => worker.dispose());
      };
    }, [onRawLogsUrl, stepsUrl]);

    const style = React.createElement("style", null, `
      :host { display: block; }
      .gha-root { background: var(--bgColor-default, #0d1117); border: 1px solid var(--borderColor-default, #30363d); border-radius: 6px; color: var(--fgColor-default, #e6edf3); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 8px 0; padding: 12px; }
      .gha-title { font-weight: 600; margin-bottom: 4px; }
      .gha-muted { color: var(--fgColor-muted, #8b949e); }
      .gha-error { color: var(--fgColor-danger, #ff7b72); }
      .gha-steps { margin-top: 12px; }
      .gha-step + .gha-step { margin-top: 12px; }
      .gha-step { border: 1px solid var(--borderColor-muted, #21262d); border-radius: 6px; overflow: clip; scroll-margin-top: var(--gha-step-sticky-top, 0px); }
      .gha-step-title { align-items: center; background: var(--bgColor-muted, #161b22); border-bottom: 1px solid var(--borderColor-muted, #21262d); box-sizing: border-box; display: flex; position: sticky; top: var(--gha-step-sticky-top, 0px); width: 100%; z-index: 1; }
      .gha-step-toggle { appearance: none; background: none; border: 0; color: inherit; cursor: pointer; flex: 1; font: inherit; font-weight: 600; min-width: 0; padding: 8px 10px; text-align: left; }
      .gha-step-static { font-weight: 600; padding: 8px 10px; }
      .gha-step-navigation { display: flex; gap: 8px; padding-right: 10px; }
      .gha-step-navigation-link { color: var(--fgColor-accent, #58a6ff); font-size: 14px; font-weight: 600; text-decoration: none; white-space: nowrap; }
      .gha-step-navigation-link:hover { text-decoration: underline; }
      .gha-step-navigation-button { appearance: none; background: none; border: 0; cursor: pointer; font: inherit; padding: 0; }
      .gha-step-navigation-button:disabled { cursor: wait; opacity: 0.65; }
      .gha-step--no-log { border-style: dashed; opacity: 0.75; }
      .gha-step--skipped .gha-step-title { position: static; }
      .gha-step-icon, .gha-step-chevron { color: var(--fgColor-muted, #8b949e); display: inline-block; margin-right: 6px; }
      .gha-step-chevron { width: 1em; }
      .gha-step-icon { width: 1.25em; text-align: center; }
      .gha-step-duration { color: var(--fgColor-muted, #8b949e); font-weight: 400; margin-left: 8px; white-space: nowrap; }
      .gha-log { background: var(--bgColor-default, #0d1117); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 6px 0; }
      .gha-log-chunk { content-visibility: auto; }
      .gha-log-line { display: grid; grid-template-columns: 10ch minmax(0, 1fr); min-height: 18px; }
      .gha-log-line::before { border-right: 1px solid var(--borderColor-muted, #21262d); box-sizing: border-box; color: var(--fgColor-muted, #8b949e); overflow: hidden; padding: 0 10px; text-align: right; text-overflow: ellipsis; user-select: none; white-space: nowrap; }
      .gha-log-timestamp { color: var(--fgColor-muted, #8b949e); display: none; overflow: hidden; padding: 0 10px; text-overflow: ellipsis; user-select: none; white-space: nowrap; }
      :host([data-gha-show-timestamps]) .gha-log-line { grid-template-columns: 10ch 25ch minmax(0, 1fr); }
      :host([data-gha-show-timestamps]) .gha-log-timestamp { display: block; }
      .gha-log--complete { counter-reset: gha-line; }
      .gha-log--complete .gha-log-line { counter-increment: gha-line; }
      .gha-log--complete .gha-log-line::before { content: counter(gha-line); }
      .gha-log--partial .gha-log-line::before { content: attr(data-offset); }
      .gha-log-content { min-width: 0; padding: 0 10px; tab-size: 4; white-space: pre; }
      .gha-log-line--wrap .gha-log-content { overflow-wrap: anywhere; white-space: pre-wrap; }
      .gha-log-status { padding: 10px; }
    `);

    let body: React.ReactNode;
    if (state.status === "loading") body = React.createElement("div", { className: "gha-muted" }, "Loading GitHub Actions log data…");
    else if (state.status === "error") body = React.createElement("div", { className: "gha-error" }, state.message);
    else body = React.createElement(
      React.Fragment,
      null,
      React.createElement("div", { className: "gha-muted" }, `Loaded ${state.steps.length} step${state.steps.length === 1 ? "" : "s"}.`),
      React.createElement("div", { className: "gha-steps" }, state.steps.map((step, index) => React.createElement(StepLogView, {
        key: step.id ?? step.log_url ?? `step-${index}`,
        step,
        index,
        wrapColumns,
        onInitialLogRendered: step.log_url && !isCollapsedByDefault(step) ? reportInitialLogRendered : undefined,
      }))),
    );

    return React.createElement(React.Fragment, null, style, React.createElement("div", { className: "gha-root" }, React.createElement("div", { className: "gha-title" }, "GHA++"), body));
  }

  extensionGlobal.GHAPlusPlusReactApp = {
    mount(logContainer, stepsUrl, onInitialLogsComplete, onRawLogsUrl): void {
      const host = document.createElement("div");
      host.dataset.ghaPlusplusApp = "";
      const shadow = host.attachShadow({ mode: "open" });
      const mountPoint = document.createElement("div");
      shadow.append(mountPoint);
      logContainer.insertAdjacentElement("afterend", host);
      stickyToolbarDisposers.set(host, keepStepHeadersBelowToolbar(host));
      let wrapColumns = measureWrapColumns(host, shadow);
      const render = (): void => {
        ReactDOM.render(
          React.createElement(JobLogApp, {
            stepsUrl,
            onInitialLogsComplete,
            onRawLogsUrl,
            wrapColumns,
          }),
          mountPoint,
        );
      };
      render();
      const observer = new ResizeObserver(() => {
        const nextColumns = measureWrapColumns(host, shadow);
        if (Math.abs(nextColumns - wrapColumns) < 2) return;
        wrapColumns = nextColumns;
        render();
      });
      observer.observe(host);
      resizeObservers.set(host, observer);
    },
    unmount(host): void {
      resizeObservers.get(host)?.disconnect();
      resizeObservers.delete(host);
      stickyToolbarDisposers.get(host)?.();
      stickyToolbarDisposers.delete(host);
      const mountPoint = host.shadowRoot?.firstElementChild;
      if (mountPoint instanceof HTMLElement) ReactDOM.unmountComponentAtNode(mountPoint);
      host.remove();
    },
  };
})();
