(() => {
  "use strict";

  const JOB_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+\/?$/;
  interface NavigationEvent {
    url: URL;
    previousUrl: URL | null;
  }

  type NavigationCallback = (navigation: NavigationEvent) => void;
  type WindowWithNavigation = Window & { navigation?: EventTarget };

  interface JobStep {
    log_url: string;
    length?: Promise<number>;
    getLines?: () => Promise<LogElement[]>;
  }

  type LogElement =
    | { Line: [timestampMs: number, html: string] }
    | { Group: [timestampMs: number, html: string, children: LogElement[]] };

  interface ParsedLog {
    elements: LogElement[];
    length: number;
  }

  interface LogWorkerResponse {
    type: "initialized" | "lines" | "error";
    elements?: LogElement[];
    length?: number;
    error?: string;
  }

  interface ChromeRuntime {
    runtime: { getURL(path: string): string };
  }

  const extensionChrome = (
    globalThis as typeof globalThis & { chrome: ChromeRuntime }
  ).chrome;
  const APP_SELECTOR = "[data-gha-plusplus-app]";

  /**
   * A persistent parser worker for one log step. The extension-origin iframe
   * is required because GitHub's page cannot construct extension workers.
   */
  class StepLogWorker {
    private readonly host: HTMLIFrameElement;
    private readonly hostOrigin: string;
    private readonly ready: Promise<void>;
    private resolveReady!: () => void;
    private rejectReady!: (error: Error) => void;
    private result: Promise<ParsedLog> | null = null;
    private resolveResult: ((result: ParsedLog) => void) | null = null;
    private rejectResult: ((error: Error) => void) | null = null;
    private disposed = false;

    private constructor(logUrl: string) {
      const hostUrl = extensionChrome.runtime.getURL("worker-host.html");
      this.hostOrigin = new URL(hostUrl).origin;
      this.host = document.createElement("iframe");
      this.host.hidden = true;
      this.host.src = hostUrl;
      this.ready = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });

      window.addEventListener("message", this.handleMessage);
      this.host.addEventListener("load", () => {
        this.post({ type: "init", logUrl });
      }, { once: true });
      this.host.addEventListener("error", () => {
        this.fail(new Error("Unable to load the log parser worker host"));
      }, { once: true });
      document.documentElement.append(this.host);
    }

    static async create(logUrl: string): Promise<StepLogWorker> {
      const worker = new StepLogWorker(logUrl);
      await worker.ready;
      return worker;
    }

    getLines(): Promise<LogElement[]> {
      return this.getResult().then((result) => result.elements);
    }

    getLength(): Promise<number> {
      return this.getResult().then((result) => result.length);
    }

    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.post({ type: "dispose" });
      this.host.remove();
      window.removeEventListener("message", this.handleMessage);
      this.fail(new Error("Log parser worker was disposed"));
    }

    private getResult(): Promise<ParsedLog> {
      if (this.disposed) {
        return Promise.reject(new Error("Log parser worker was disposed"));
      }
      if (this.result) return this.result;

      this.result = new Promise<ParsedLog>((resolve, reject) => {
        this.resolveResult = resolve;
        this.rejectResult = reject;
        this.post({ type: "get-lines" });
      });
      return this.result;
    }

    private post(message: { type: string; logUrl?: string }): void {
      this.host.contentWindow?.postMessage(message, this.hostOrigin);
    }

    private readonly handleMessage = (event: MessageEvent<LogWorkerResponse>): void => {
      if (event.source !== this.host.contentWindow || event.origin !== this.hostOrigin) return;

      const message = event.data;
      if (message.type === "initialized") {
        this.resolveReady();
      } else if (message.type === "lines") {
        this.resolveResult?.({
          elements: message.elements ?? [],
          length: message.length ?? 0,
        });
        this.resolveResult = null;
        this.rejectResult = null;
      } else if (message.type === "error") {
        this.fail(new Error(message.error ?? "Unknown log parser error"));
      }
    };

    private fail(error: Error): void {
      this.rejectReady(error);
      this.rejectResult?.(error);
      this.resolveResult = null;
      this.rejectResult = null;
    }
  }

  function waitForElement<T extends Element>(
    selector: string,
    timeoutMs = 5000,
  ): Promise<T | null> {
    const existing = document.querySelector<T>(selector);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const element = document.querySelector<T>(selector);
        if (!element) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve(element);
      });
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
      observer.observe(document, { childList: true, subtree: true });
    });
  }

  /**
   * Runs callback once for the initial URL and once for each committed URL
   * transition. GitHub emits more than one event for a soft navigation, so URL
   * delivery is deduplicated independently from the event that detected it.
   */
  function onNavigation(callback: NavigationCallback): () => void {
    let deliveredUrl: string | null = null;
    let scheduled = false;

    const deliver = (): void => {
      scheduled = false;

      const nextUrl = location.href;
      if (nextUrl === deliveredUrl) return;

      const previousUrl = deliveredUrl ? new URL(deliveredUrl) : null;
      deliveredUrl = nextUrl;
      callback({ url: new URL(nextUrl), previousUrl });
    };

    // Coalesce history, Turbo, Navigation API, and DOM signals generated by a
    // single GitHub navigation into one callback at the next rendered frame.
    const schedule = (): void => {
      if (scheduled || location.href === deliveredUrl) return;
      scheduled = true;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", deliver, { once: true });
      } else {
        requestAnimationFrame(deliver);
      }
    };

    const eventNames = [
      "turbo:load",
      "turbo:render",
      "pjax:end",
      "popstate",
      "hashchange",
    ];

    for (const eventName of eventNames) {
      window.addEventListener(eventName, schedule, true);
    }

    const navigation = (window as WindowWithNavigation).navigation;
    navigation?.addEventListener("navigatesuccess", schedule);

    // Fallback for GitHub navigation mechanisms that do not emit a public
    // event. Mutations only trigger a URL comparison; callback remains deduped.
    const observer = new MutationObserver(schedule);
    observer.observe(document, { childList: true, subtree: true });

    schedule();

    return (): void => {
      observer.disconnect();
      for (const eventName of eventNames) {
        window.removeEventListener(eventName, schedule, true);
      }
      navigation?.removeEventListener("navigatesuccess", schedule);
    };
  }

  function JobLogApp({ stepsUrl }: { stepsUrl: string }) {
    type State =
      | { status: "loading" }
      | { status: "ready"; steps: JobStep[] }
      | { status: "error"; message: string };

    const [state, setState] = React.useState<State>({ status: "loading" });

    React.useEffect(() => {
      let cancelled = false;
      const workers = new Set<StepLogWorker>();

      async function loadSteps(): Promise<void> {
        setState({ status: "loading" });

        const stepsRequest = await fetch(stepsUrl, {
          headers: { "Accept": "application/json" },
        });
        if (!stepsRequest.ok) {
          throw new Error(`Steps request failed with HTTP ${stepsRequest.status}`);
        }
        const rawSteps = await stepsRequest.json() as JobStep[];
        const steps = await Promise.all(rawSteps.map(async (step) => {
          const logUrl = new URL(step.log_url, location.origin).href;
          const worker = await StepLogWorker.create(logUrl);
          if (cancelled) {
            worker.dispose();
            throw new Error("Job log app was unmounted");
          }
          workers.add(worker);

          // Keep the current eager behavior, while exposing getLines for the
          // component that will eventually render an individual step.
          const getLines = worker.getLines.bind(worker);
          const initialLines = getLines();
          return {
            ...step,
            getLines: () => initialLines,
            length: worker.getLength(),
          };
        }));

        console.info("Steps are", steps);
        if (!cancelled) setState({ status: "ready", steps });
      }

      loadSteps().catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

      return () => {
        cancelled = true;
        workers.forEach((worker) => worker.dispose());
      };
    }, [stepsUrl]);

    const style = React.createElement("style", null, `
      :host {
        display: block;
      }
      .gha-root {
        background: var(--bgColor-default, #0d1117);
        border: 1px solid var(--borderColor-default, #30363d);
        border-radius: 6px;
        color: var(--fgColor-default, #e6edf3);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 8px 0;
        padding: 12px;
      }
      .gha-title {
        font-weight: 600;
        margin-bottom: 4px;
      }
      .gha-muted {
        color: var(--fgColor-muted, #8b949e);
      }
      .gha-error {
        color: var(--fgColor-danger, #ff7b72);
      }
    `);

    let body: React.ReactNode;
    if (state.status === "loading") {
      body = React.createElement("div", { className: "gha-muted" }, "Loading GitHub Actions log data…");
    } else if (state.status === "error") {
      body = React.createElement("div", { className: "gha-error" }, state.message);
    } else {
      body = React.createElement(
        "div",
        { className: "gha-muted" },
        `Loaded ${state.steps.length} step${state.steps.length === 1 ? "" : "s"}.`,
      );
    }

    return React.createElement(
      React.Fragment,
      null,
      style,
      React.createElement(
        "div",
        { className: "gha-root" },
        React.createElement("div", { className: "gha-title" }, "GHA++"),
        body,
      ),
    );
  }

  function removeMountedApps(): void {
    document.querySelectorAll<HTMLElement>(APP_SELECTOR).forEach((host) => {
      const mountPoint = host.shadowRoot?.firstElementChild;
      if (mountPoint instanceof HTMLElement) {
        ReactDOM.unmountComponentAtNode(mountPoint);
      }
      host.remove();
    });
  }

  async function mountJobLogApp(): Promise<void> {
    const stepsElement = await waitForElement<HTMLElement>("[data-job-steps-url]");
    const stepsUrl = stepsElement
      ?.getAttribute("data-job-steps-url");
    if (!stepsUrl) throw new Error("Unable to find GitHub Actions steps URL");

    const container = await waitForElement<HTMLElement>(".js-full-logs-container");
    if (!container) throw new Error("Unable to find GitHub Actions log container");

    removeMountedApps();

    const host = document.createElement("div");
    host.dataset.ghaPlusplusApp = "";
    const shadow = host.attachShadow({ mode: "open" });
    const mountPoint = document.createElement("div");
    shadow.append(mountPoint);
    container.append(host);

    ReactDOM.render(
      React.createElement(JobLogApp, { stepsUrl }),
      mountPoint,
    );
  }

  async function handleNavigation({ url }: NavigationEvent): Promise<void> {
    if (url.hostname !== "github.com" || !JOB_PATH.test(url.pathname)) {
      removeMountedApps();
      return;
    }

    await mountJobLogApp();
  }

  onNavigation(handleNavigation);
})();
