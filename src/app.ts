(() => {
  "use strict";

  interface JobStep extends GitHubJobStep {
    logView?: LogViewClient;
  }

  type ExtensionGlobal = typeof globalThis & {
    GHAPlusPlusReactApp?: GHAPlusPlusReactApp;
  };
  const extensionChrome = (
    globalThis as typeof globalThis & { chrome: ExtensionChrome }
  ).chrome;
  const extensionGlobal = globalThis as ExtensionGlobal;
  const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>();
  const stickyToolbarDisposers = new WeakMap<HTMLElement, () => void>();
  const scrollRestorationFloors = new WeakMap<HTMLElement, HTMLStyleElement>();
  const JOB_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+\/?$/;
  const SCROLL_RESTORATION_MIN_HEIGHT = "10000000px";
  const WORKER_HOST_URL = extensionChrome.runtime.getURL("worker-host.html");
  const WORKER_HOST_ORIGIN = new URL(WORKER_HOST_URL).origin;
  const APP_STYLES = `
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
    .gha-log-line::before { border-right: 1px solid var(--borderColor-muted, #21262d); box-sizing: border-box; color: var(--fgColor-muted, #8b949e); content: attr(data-offset); overflow: hidden; padding: 0 10px; text-align: right; text-overflow: ellipsis; user-select: none; white-space: nowrap; }
    .gha-log-timestamp { color: var(--fgColor-muted, #8b949e); display: none; overflow: hidden; padding: 0 10px; text-overflow: ellipsis; user-select: none; white-space: nowrap; }
    :host([data-gha-show-timestamps]) .gha-log-line { grid-template-columns: 10ch 25ch minmax(0, 1fr); }
    :host([data-gha-show-timestamps]) .gha-log-timestamp { display: block; }
    .gha-log-content { min-width: 0; padding: 0 10px; tab-size: 4; white-space: pre; }
    .gha-log-line--wrap .gha-log-content { overflow-wrap: anywhere; white-space: pre-wrap; }
    .gha-log-status { padding: 10px; }
  `;

  function createScrollRestorationFloor(): HTMLStyleElement {
    const floor = document.createElement("style");
    floor.textContent = `html, body { min-height: ${SCROLL_RESTORATION_MIN_HEIGHT} !important; }`;
    document.documentElement.append(floor);
    return floor;
  }

  let pendingScrollRestorationFloor = JOB_PATH.test(location.pathname)
    ? createScrollRestorationFloor()
    : null;
  window.addEventListener("load", () => {
    window.requestAnimationFrame(() => {
      pendingScrollRestorationFloor?.remove();
      pendingScrollRestorationFloor = null;
    });
  }, { once: true });

  /** The message-port handle for one worker LogView. */
  class WorkerLogViewClient {
    private closed = false;
    private failed = false;
    private revision = 0;
    private pendingLoad: Promise<void> | null = null;
    private resolveLoad: (() => void) | null = null;

    constructor(
      private readonly port: MessagePort,
      private readonly listener: (event: LogViewEvent) => void,
    ) {
      port.onmessage = this.handleMessage;
      port.addEventListener("close", this.handleClose);
      port.start();
    }

    load(): Promise<void> {
      if (this.pendingLoad) return this.pendingLoad;
      this.pendingLoad = new Promise((resolve) => { this.resolveLoad = resolve; });
      this.post({ type: "load" });
      return this.pendingLoad;
    }

    fetchPrevious(): void {
      this.post({ type: "fetch-previous" });
    }

    setWrapColumns(wrapColumns: number): void {
      this.post({ type: "set-wrap-columns", wrapColumns });
    }

    private reportError(error: unknown): void {
      this.failed = true;
      const event = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      } as const;
      this.listener(event);
      this.finishLoad();
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.port.onmessage = null;
      this.port.removeEventListener("close", this.handleClose);
      this.port.close();
      this.finishLoad();
    }

    private post(command: LogViewCommand): void {
      if (this.closed) throw new Error("Log view was closed");
      this.port.postMessage(command);
    }

    private readonly handleMessage = (event: MessageEvent<LogViewEvent>): void => {
      const message = event.data;
      if (message.type === "render") {
        const expected = this.revision + 1;
        if (message.revision !== expected) {
          this.reportError(new Error(
            `Log view expected render revision ${expected}, received ${message.revision}`,
          ));
          return;
        }
        this.failed = false;
        this.revision = message.revision;
        this.listener(message);
        this.finishLoad();
        return;
      }
      this.reportError(message.message);
    };

    private readonly handleClose = (): void => {
      if (this.closed) return;
      this.closed = true;
      this.port.onmessage = null;
      this.port.removeEventListener("close", this.handleClose);
      if (!this.failed) {
        const event = { type: "error", message: "Log view channel was closed" } as const;
        this.listener(event);
      }
      this.finishLoad();
    };

    private finishLoad(): void {
      const resolve = this.resolveLoad;
      this.resolveLoad = null;
      this.pendingLoad = null;
      resolve?.();
    }
  }

  /** A lazily started extension worker that owns one shared fetched log source. */
  class LogSourceClient {
    private hostReady: Promise<Window> | null = null;

    constructor(
      private readonly step: GitHubJobStep,
      private readonly stepsUrl: string,
      private readonly signal: AbortSignal,
    ) { }

    private ensureHost(): Promise<Window> {
      if (this.hostReady) return this.hostReady;
      const { signal } = this;
      const host = document.createElement("iframe");
      host.hidden = true;
      host.src = WORKER_HOST_URL;
      this.hostReady = new Promise<Window>((resolve, reject) => {
        const cleanupLoad = (): void => {
          host.removeEventListener("load", handleLoad);
          host.removeEventListener("error", handleError);
        };
        const handleLoad = (): void => {
          cleanupLoad();
          const hostWindow = host.contentWindow;
          if (hostWindow) {
            hostWindow.postMessage(
              {
                type: "initialize-source",
                step: this.step,
                stepsUrl: this.stepsUrl,
              } satisfies InitializeLogSourceMessage,
              WORKER_HOST_ORIGIN,
            );
            resolve(hostWindow);
          } else {
            signal.removeEventListener("abort", handleAbort);
            host.remove();
            reject(new Error("Log source host has no content window"));
          }
        };
        const handleError = (): void => {
          cleanupLoad();
          signal.removeEventListener("abort", handleAbort);
          host.remove();
          reject(new Error("Unable to load the log source host"));
        };
        const handleAbort = (): void => {
          cleanupLoad();
          host.remove();
          reject(signal.reason);
        };
        host.addEventListener("load", handleLoad);
        host.addEventListener("error", handleError);
        signal.addEventListener("abort", handleAbort, { once: true });
      });
      document.documentElement.append(host);
      return this.hostReady;
    }

    async createView(
      wrapColumns: number,
      listener: (event: LogViewEvent) => void,
    ): Promise<WorkerLogViewClient> {
      const channel = new MessageChannel();
      const view = new WorkerLogViewClient(channel.port2, listener);
      try {
        const hostWindow = await this.ensureHost();
        hostWindow.postMessage(
          {
            type: "create-view",
            wrapColumns,
          } satisfies CreateLogViewMessage,
          WORKER_HOST_ORIGIN,
          [channel.port1],
        );
        return view;
      } catch (error) {
        view.close();
        throw error;
      }
    }
  }

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

  type LoadPriority = "interactive" | "initial" | "background";

  interface ScheduledLogLoad {
    load: () => Promise<void>;
    priority: LoadPriority;
    countsTowardInitial: boolean;
    started: boolean;
  }

  /** Bounded queue shared by initial, background, and interactive log work. */
  class LogLoadPrioritizer {
    private readonly queues: Record<LoadPriority, ScheduledLogLoad[]> = {
      interactive: [],
      initial: [],
      background: [],
    };
    private active = 0;
    private pendingInitial = 0;
    private started = false;
    private initialCompletionNotified = false;

    constructor(
      private readonly signal: AbortSignal,
      private readonly onInitialLoadsComplete: () => void,
      private readonly concurrency = 2,
    ) {
      signal.addEventListener("abort", this.handleAbort, { once: true });
    }

    scheduleInitial(load: () => Promise<void>): ScheduledLogLoad {
      this.pendingInitial += 1;
      return this.schedule(load, "initial", true);
    }

    scheduleBackground(load: () => Promise<void>): ScheduledLogLoad {
      return this.schedule(load, "background", false);
    }

    start(): void {
      this.started = true;
      this.notifyInitialCompletion();
      this.drain();
    }

    promote(task: ScheduledLogLoad): void {
      if (!task.started && task.priority === "background") {
        this.remove(task);
        task.priority = "interactive";
        this.queues.interactive.push(task);
      }
      this.drain();
    }

    private readonly handleAbort = (): void => {
      for (const priority of Object.keys(this.queues) as LoadPriority[]) {
        this.queues[priority] = [];
      }
    };

    private schedule(
      load: () => Promise<void>,
      priority: LoadPriority,
      countsTowardInitial: boolean,
    ): ScheduledLogLoad {
      const task: ScheduledLogLoad = {
        load,
        priority,
        countsTowardInitial,
        started: false,
      };
      this.queues[priority].push(task);
      return task;
    }

    private next(): ScheduledLogLoad | undefined {
      return this.queues.interactive.shift()
        ?? this.queues.initial.shift()
        ?? (this.pendingInitial === 0
          ? this.queues.background.shift()
          : undefined);
    }

    private drain(): void {
      if (!this.started) return;
      while (!this.signal.aborted && this.active < this.concurrency) {
        const task = this.next();
        if (!task) return;

        task.started = true;
        this.active += 1;
        void this.run(task);
      }
    }

    private async run(task: ScheduledLogLoad): Promise<void> {
      try {
        await task.load();
      } catch {
        // The view callback reports load errors to React.
      } finally {
        this.active -= 1;
        if (task.countsTowardInitial) this.pendingInitial -= 1;
        this.notifyInitialCompletion();
        this.drain();
      }
    }

    private remove(task: ScheduledLogLoad): void {
      const queue = this.queues[task.priority];
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
    }

    private notifyInitialCompletion(): void {
      if (
        this.signal.aborted
        || !this.started
        || this.pendingInitial !== 0
        || this.initialCompletionNotified
      ) return;
      this.initialCompletionNotified = true;
      this.onInitialLoadsComplete();
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
      return { icon: "◐", label: "In progress", message: "In progress — waiting for log output.", kind: "in-progress" };
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

  /** Owns a step's detached log DOM and its prioritized worker load. */
  class LogViewClient {
    private static readonly hostGroups = new WeakMap<HTMLElement, {
      columns: number;
      views: Set<LogViewClient>;
    }>();

    static resize(host: HTMLElement): void {
      const group = this.hostGroups.get(host);
      const view = group?.views.values().next().value;
      if (!group || !view) return;
      const columns = view.measureWrapColumns();
      if (Math.abs(columns - group.columns) < 2) return;
      group.columns = columns;
      group.views.forEach((logView) => logView.updateWrapColumns(columns));
    }

    readonly element = document.createElement("div");

    private listener: ((event: LogViewEvent) => void) | null = null;
    private workerView: WorkerLogViewClient | null = null;
    private rendered = false;
    private wrapColumns: number;
    private readonly task: ScheduledLogLoad;

    constructor(
      private readonly source: LogSourceClient,
      private readonly prioritizer: LogLoadPrioritizer,
      initial: boolean,
      private readonly signal: AbortSignal,
      private readonly host: HTMLElement,
    ) {
      let group = LogViewClient.hostGroups.get(host);
      if (!group) {
        group = { columns: this.measureWrapColumns(), views: new Set() };
        LogViewClient.hostGroups.set(host, group);
      }
      this.wrapColumns = group.columns;
      group.views.add(this);
      signal.addEventListener("abort", () => group.views.delete(this), { once: true });
      this.task = initial
        ? prioritizer.scheduleInitial(() => this.load())
        : prioritizer.scheduleBackground(() => this.load());
    }

    attach(
      host: HTMLElement,
      listener: (event: LogViewEvent) => void,
    ): void {
      this.listener = listener;
      host.replaceChildren(this.element);
    }

    detach(host: HTMLElement): void {
      if (this.element.parentElement === host) this.element.remove();
      this.listener = null;
    }

    prioritize(): void {
      this.prioritizer.promote(this.task);
    }

    fetchPrevious(): void {
      this.workerView?.fetchPrevious();
    }

    private async load(): Promise<void> {
      try {
        this.workerView = await this.source.createView(
          this.wrapColumns,
          this.handleWorkerEvent,
        );
        await this.workerView.load();
      } catch (error) {
        if (!this.signal.aborted) this.reportError(error);
        throw error;
      }
    }

    private readonly handleWorkerEvent = (event: LogViewEvent): void => {
      if (this.signal.aborted) return;
      if (event.type === "error") {
        this.listener?.(event);
        return;
      }
      try {
        this.applyRender(event);
        this.listener?.(event);
        this.rendered = true;
        if (event.wrapColumns !== this.wrapColumns) {
          this.workerView?.setWrapColumns(this.wrapColumns);
        }
      } catch (error) {
        this.reportError(error);
      }
    };

    private measureWrapColumns(): number {
      if (this.host.clientWidth === 0) return 120;
      const probe = document.createElement("span");
      probe.textContent = "0000000000";
      probe.style.cssText = "font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; position: absolute; visibility: hidden; white-space: pre;";
      this.host.shadowRoot?.append(probe);
      const characterWidth = probe.getBoundingClientRect().width / 10;
      probe.remove();
      if (!Number.isFinite(characterWidth) || characterWidth <= 0) return 120;
      // Reserve the fixed line-number gutter plus horizontal padding.
      return Math.max(40, Math.floor((this.host.clientWidth - characterWidth * 12 - 24) / characterWidth));
    }

    private updateWrapColumns(wrapColumns: number): void {
      this.wrapColumns = wrapColumns;
      if (this.rendered) this.workerView?.setWrapColumns(wrapColumns);
    }

    private applyRender(render: Extract<LogViewEvent, { type: "render" }>): void {
      const { splice } = render;
      if (
        splice.index > this.element.childElementCount
        || splice.index + splice.deleteCount > this.element.childElementCount
      ) {
        throw new Error(`Log view received an invalid chunk splice at revision ${render.revision}`);
      }
      const fragment = document.createDocumentFragment();
      for (let deleted = 0; deleted < splice.deleteCount; deleted += 1) {
        this.element.children.item(splice.index)?.remove();
      }
      splice.chunks.forEach((chunk) => {
        const element = document.createElement("div");
        element.className = "gha-log-chunk";
        element.style.containIntrinsicSize = `auto ${chunk.estimatedHeight}px`;
        element.innerHTML = chunk.html;
        fragment.append(element);
      });
      this.element.insertBefore(fragment, this.element.children.item(splice.index));
      this.element.className = "gha-log";
    }

    private reportError(error: unknown): void {
      this.listener?.({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function StepLogView({
    step,
    index,
  }: {
    step: JobStep;
    index: number;
  }) {
    type State =
      | { status: "loading" }
      | { status: "ready"; complete: boolean }
      | { status: "error"; message: string };

    const [state, setState] = React.useState<State>({ status: "loading" });
    const [collapsed, setCollapsed] = React.useState(() => isCollapsedByDefault(step));
    const [fetchingPrevious, setFetchingPrevious] = React.useState(false);
    const logContainer = React.useRef<HTMLDivElement>(null);
    const section = React.useRef<HTMLElement>(null);

    React.useLayoutEffect(() => {
      const view = step.logView;
      const container = logContainer.current;
      if (!view || !container) return undefined;
      view.attach(container, (event) => {
        setFetchingPrevious(false);
        if (event.type === "error") {
          setState({ status: "error", message: event.message });
          return;
        }
        setState({
          status: "ready",
          complete: event.complete,
        });
      });
      return () => view.detach(container);
    }, [step]);

    React.useEffect(() => {
      if (!collapsed) step.logView?.prioritize();
    }, [collapsed, step]);

    const title = step.name || `Step ${step.number ?? index + 1}`;
    const duration = stepDuration(step);
    const presentation = stepPresentation(step);
    const skipped = presentation.kind === "skipped";
    const logless = step.logView ? null : presentation;
    const scrollToStep = (position: "start" | "end"): void => {
      const target = section.current;
      if (!target) return;
      const options = { block: position, inline: "nearest", behavior: "instant" as ScrollBehavior } as const;
      target.scrollIntoView(options);
    };
    const fetchPrevious = (): void => {
      const view = step.logView;
      if (fetchingPrevious || state.status !== "ready" || state.complete || !view) return;
      setFetchingPrevious(true);
      view.fetchPrevious();
    };
    let content: React.ReactNode = null;
    if (!skipped) {
      if (logless) {
        if (!collapsed) content = React.createElement("div", { className: "gha-log-status gha-muted" }, logless.message);
      } else {
        content = React.createElement(
          "div",
          { hidden: collapsed },
          React.createElement("div", {
            className: "gha-log-status gha-muted",
            hidden: state.status !== "loading",
          }, step.logView ? "Loading log…" : "Preparing log…"),
          React.createElement("div", {
            className: "gha-log-status gha-error",
            hidden: state.status !== "error",
          }, state.status === "error" ? state.message : ""),
          React.createElement("div", {
            ref: logContainer,
            hidden: state.status !== "ready",
          }),
        );
      }
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
          state.status === "ready" && !state.complete && step.logView && React.createElement("button", {
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
    actions,
    host,
  }: {
    stepsUrl: string;
    actions: HTMLElement;
    host: HTMLElement;
  }) {
    type State =
      | { status: "loading" }
      | { status: "ready"; steps: JobStep[]; rawLogsUrl: string | null }
      | { status: "error"; message: string };
    const [state, setState] = React.useState<State>({ status: "loading" });
    const [initialLoadsComplete, setInitialLoadsComplete] = React.useState(false);
    const [timestampsShown, setTimestampsShown] = React.useState(false);
    const [pageLoadComplete, setPageLoadComplete] = React.useState(document.readyState === "complete");
    const scrollFloorRemoved = React.useRef(false);

    React.useEffect(() => {
      if (pageLoadComplete) return undefined;
      if (document.readyState === "complete") {
        setTimeout(() => setPageLoadComplete(true), 0);
        return () => undefined;
      }
      const handleLoad = (): void => setPageLoadComplete(true);
      window.addEventListener("load", handleLoad, { once: true });
      return () => window.removeEventListener("load", handleLoad);
    }, [pageLoadComplete]);

    React.useLayoutEffect(() => {
      const ready = state.status === "error"
        || (state.status === "ready" && initialLoadsComplete);
      if (!pageLoadComplete || !ready || scrollFloorRemoved.current) return undefined;
      const frame = window.requestAnimationFrame(() => {
        if (scrollFloorRemoved.current) return;
        scrollFloorRemoved.current = true;
        scrollRestorationFloors.get(host)?.remove();
        scrollRestorationFloors.delete(host);
      });
      return () => window.cancelAnimationFrame(frame);
    }, [host, initialLoadsComplete, pageLoadComplete, state]);

    React.useEffect(() => {
      if (state.status !== "ready") return;
      try {
        setTimeout(() => {
          document.querySelector('*[data-active]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        }, 1000);
      } catch (e) {
        console.warn(`Failed to scroll active step into view: ${e}`);
      }
    }, [state.status]);

    React.useEffect(() => {
      const controller = new AbortController();
      const { signal } = controller;
      setInitialLoadsComplete(false);
      const prioritizer = new LogLoadPrioritizer(signal, () => {
        if (!signal.aborted) setInitialLoadsComplete(true);
      });

      async function loadSteps(): Promise<void> {
        setState({ status: "loading" });
        const stepsRequest = await fetch(stepsUrl, {
          headers: { Accept: "application/json" },
          signal,
        });
        if (!stepsRequest.ok) throw new Error(`Steps request failed with HTTP ${stepsRequest.status}`);
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
        const steps = rawSteps.map((step) => {
          const running = step.status === "in_progress";
          if ((!step.log_url && !(running && step.id)) || stepPresentation(step).kind === "skipped") {
            return step;
          }
          const source = new LogSourceClient(
            step,
            new URL(stepsUrl, location.origin).href,
            signal,
          );
          return {
            ...step,
            logView: new LogViewClient(
              source,
              prioritizer,
              !isCollapsedByDefault(step),
              signal,
              host,
            ),
          };
        });
        prioritizer.start();
        setState({ status: "ready", steps, rawLogsUrl });
      }

      loadSteps().catch((error: unknown) => {
        if (signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
      return () => {
        controller.abort();
      };
    }, [stepsUrl]);

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
      }))),
    );

    const rawLogsUrl = state.status === "ready" ? state.rawLogsUrl : null;
    const actionsPortal = ReactDOM.createPortal(
      React.createElement(
        React.Fragment,
        null,
        React.createElement("button", {
          className: "Button Button--secondary Button--small",
          type: "button",
          onClick: () => {
            const nextTimestampsShown = !timestampsShown;
            host.toggleAttribute("data-gha-show-timestamps", nextTimestampsShown);
            setTimestampsShown(nextTimestampsShown);
          },
        }, timestampsShown ? "Hide timestamps" : "Show timestamps"),
        React.createElement("button", {
          className: "Button Button--secondary Button--small",
          type: "button",
          disabled: !rawLogsUrl,
          onClick: () => {
            if (rawLogsUrl) window.open(rawLogsUrl, "_blank", "noopener,noreferrer");
          },
        }, "View raw logs"),
      ),
      actions,
    );

    return React.createElement(
      React.Fragment,
      null,
      actionsPortal,
      React.createElement("div", { className: "gha-root" }, React.createElement("div", { className: "gha-title" }, "GHA++"), body),
    );
  }

  extensionGlobal.GHAPlusPlusReactApp = {
    mount(search, logContainer, stepsUrl): HTMLElement {
      const host = document.createElement("div");
      const scrollRestorationFloor = pendingScrollRestorationFloor
        ?? createScrollRestorationFloor();
      pendingScrollRestorationFloor = null;
      scrollRestorationFloors.set(host, scrollRestorationFloor);
      search.replaceChildren();
      search.className = "gha-plusplus-log-actions";
      search.style.cssText = "display: flex; gap: 8px; margin: 0 0 12px;";
      logContainer.replaceChildren();
      host.dataset.ghaPlusplusApp = "";
      const shadow = host.attachShadow({ mode: "open" });
      const mountPoint = document.createElement("div");
      const style = document.createElement("style");
      style.textContent = APP_STYLES;
      shadow.append(mountPoint, style);
      logContainer.insertAdjacentElement("afterend", host);
      stickyToolbarDisposers.set(host, keepStepHeadersBelowToolbar(host));
      ReactDOM.render(
        React.createElement(JobLogApp, {
          stepsUrl,
          actions: search,
          host,
        }),
        mountPoint,
      );
      const observer = new ResizeObserver(() => LogViewClient.resize(host));
      observer.observe(host);
      resizeObservers.set(host, observer);
      return host;
    },
    unmount(host): void {
      scrollRestorationFloors.get(host)?.remove();
      scrollRestorationFloors.delete(host);
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
