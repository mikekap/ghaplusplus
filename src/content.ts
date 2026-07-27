(() => {
  "use strict";

  const JOB_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+\/?$/;
  const APP_SELECTOR = "[data-gha-plusplus-app]";
  const ENABLED_SETTING = "viewerEnabled";
  const SCROLL_RESTORATION_MIN_HEIGHT = "10000000px";
  let activeJobLog: { dispose(): void } | null = null;
  let navigationGeneration = 0;
  let pageLoadComplete = document.readyState === "complete";
  let initialLogFetchesComplete = false;
  let scrollRestorationFloor: HTMLStyleElement | null = null;

  interface NavigationEvent {
    url: URL;
    previousUrl: URL | null;
  }

  type NavigationCallback = (navigation: NavigationEvent) => void;
  type WindowWithNavigation = Window & { navigation?: EventTarget };

  interface ParsedLog {
    chunks: Array<{ html: string; rows: number; estimatedHeight: number }>;
    length: number;
    complete: boolean;
    wrapColumns: number;
  }

  interface LogWorkerResponse {
    type: "initialized" | "lines" | "error";
    requestId?: number;
    chunks?: Array<{ html: string; rows: number; estimatedHeight: number }>;
    length?: number;
    complete?: boolean;
    wrapColumns?: number;
    error?: string;
  }

  interface ChromeRuntime {
    runtime: { getURL(path: string): string };
  }

  interface ChromeStorage {
    sync: {
      get(defaults: Record<string, boolean>): Promise<Record<string, boolean>>;
      set(items: Record<string, boolean>): Promise<void>;
    };
    onChanged: {
      addListener(listener: (changes: Record<string, { newValue?: boolean }>, areaName: string) => void): void;
    };
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

  const extensionChrome = (
    globalThis as typeof globalThis & { chrome: ChromeRuntime & { storage: ChromeStorage } }
  ).chrome;
  const extensionGlobal = globalThis as typeof globalThis & {
    GHAPlusPlusRuntime?: GHAPlusPlusRuntime;
    GHAPlusPlusReactApp?: GHAPlusPlusReactApp;
  };

  // A content script is injected into each full document, but not for GitHub's
  // HTML5 navigations. Install this before the page can restore a deep scroll.
  if (JOB_PATH.test(location.pathname)) {
    scrollRestorationFloor = document.createElement("style");
    scrollRestorationFloor.textContent = `html, body { min-height: ${SCROLL_RESTORATION_MIN_HEIGHT} !important; }`;
    document.documentElement.append(scrollRestorationFloor);
  }

  function removeScrollRestorationFloor(): void {
    if (!pageLoadComplete || !initialLogFetchesComplete) return;
    scrollRestorationFloor?.remove();
    scrollRestorationFloor = null;
  }

  window.addEventListener("load", () => {
    pageLoadComplete = true;
    removeScrollRestorationFloor();
  }, { once: true });

  /**
   * A persistent parser worker for one log step. The extension-origin iframe
   * is required because GitHub's page cannot construct extension workers.
   */
  class StepLogWorker implements StepLogWorkerHandle {
    private readonly host: HTMLIFrameElement;
    private readonly hostOrigin: string;
    private readonly ready: Promise<void>;
    private resolveReady!: () => void;
    private rejectReady!: (error: Error) => void;
    private result: Promise<ParsedLog> | null = null;
    private nextRequestId = 1;
    private readonly pending = new Map<number, {
      resolve: (result: ParsedLog) => void;
      reject: (error: Error) => void;
    }>();
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

    getLines(wrapColumns: number): Promise<ParsedLog> {
      if (this.disposed) return Promise.reject(new Error("Log parser worker was disposed"));
      if (this.result) return this.result;
      this.result = this.request("get-lines", wrapColumns);
      return this.result;
    }

    async rewrap(wrapColumns: number): Promise<ParsedLog> {
      await this.result;
      if (this.disposed) throw new Error("Log parser worker was disposed");
      return this.request("rewrap", wrapColumns);
    }

    async fetchPrevious(wrapColumns: number): Promise<ParsedLog> {
      await this.result;
      if (this.disposed) throw new Error("Log parser worker was disposed");
      this.result = this.request("fetch-previous", wrapColumns);
      return this.result;
    }

    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.post({ type: "dispose" });
      this.host.remove();
      window.removeEventListener("message", this.handleMessage);
      this.fail(new Error("Log parser worker was disposed"));
    }

    private request(type: "get-lines" | "fetch-previous" | "rewrap", wrapColumns: number): Promise<ParsedLog> {
      const requestId = this.nextRequestId;
      this.nextRequestId += 1;
      return new Promise<ParsedLog>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        this.post({ type, requestId, wrapColumns });
      });
    }

    private post(message: {
      type: string;
      logUrl?: string;
      requestId?: number;
      wrapColumns?: number;
    }): void {
      this.host.contentWindow?.postMessage(message, this.hostOrigin);
    }

    private readonly handleMessage = (event: MessageEvent<LogWorkerResponse>): void => {
      if (event.source !== this.host.contentWindow || event.origin !== this.hostOrigin) return;

      const message = event.data;
      if (message.type === "initialized") {
        this.resolveReady();
      } else if (message.type === "lines") {
        const pending = message.requestId === undefined ? null : this.pending.get(message.requestId);
        pending?.resolve({
          chunks: message.chunks ?? [],
          length: message.length ?? 0,
          complete: message.complete ?? false,
          wrapColumns: message.wrapColumns ?? 0,
        });
        if (message.requestId !== undefined) this.pending.delete(message.requestId);
      } else if (message.type === "error") {
        const error = new Error(message.error ?? "Unknown log parser error");
        if (message.requestId === undefined) this.fail(error);
        else {
          this.pending.get(message.requestId)?.reject(error);
          this.pending.delete(message.requestId);
        }
      }
    };

    private fail(error: Error): void {
      this.rejectReady(error);
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
    }
  }

  extensionGlobal.GHAPlusPlusRuntime = {
    createStepLogWorker: StepLogWorker.create,
  };

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
    const schedule = (): void => {
      if (scheduled || location.href === deliveredUrl) return;
      scheduled = true;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", deliver, { once: true });
      } else {
        requestAnimationFrame(deliver);
      }
    };

    const eventNames = ["turbo:load", "turbo:render", "pjax:end", "popstate", "hashchange"];
    eventNames.forEach((eventName) => window.addEventListener(eventName, schedule, true));
    const navigation = (window as WindowWithNavigation).navigation;
    navigation?.addEventListener("navigatesuccess", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document, { childList: true, subtree: true });
    schedule();

    return (): void => {
      observer.disconnect();
      eventNames.forEach((eventName) => window.removeEventListener(eventName, schedule, true));
      navigation?.removeEventListener("navigatesuccess", schedule);
    };
  }

  function removeMountedApps(): void {
    document.querySelectorAll<HTMLElement>(APP_SELECTOR).forEach((host) => {
      extensionGlobal.GHAPlusPlusReactApp?.unmount(host);
    });
  }

  function disposeActiveJobLog(): void {
    activeJobLog?.dispose();
    activeJobLog = null;
    initialLogFetchesComplete = false;
  }

  async function viewerEnabled(): Promise<boolean> {
    const settings = await extensionChrome.storage.sync.get({ [ENABLED_SETTING]: true });
    return settings[ENABLED_SETTING] ?? true;
  }

  function replaceNativeLog(
    search: HTMLElement,
    logContainer: HTMLElement,
    stepsUrl: string,
    onInitialLogsComplete: () => void,
  ): { dispose(): void } {
    const nativeLogContents = document.createDocumentFragment();
    const searchPlaceholder = document.createComment("gha-plusplus-search-placeholder");
    const actions = document.createElement("div");
    const timestampsButton = document.createElement("button");
    const rawLogsButton = document.createElement("button");
    let rawLogsUrl: string | null = null;
    let timestampsShown = false;

    nativeLogContents.append(...Array.from(logContainer.childNodes));
    search.before(searchPlaceholder);
    actions.className = "gha-plusplus-log-actions";
    actions.style.cssText = "display: flex; gap: 8px; margin: 0 0 12px;";
    timestampsButton.className = "Button Button--secondary Button--small";
    timestampsButton.type = "button";
    timestampsButton.textContent = "Show timestamps";
    rawLogsButton.className = "Button Button--secondary Button--small";
    rawLogsButton.type = "button";
    rawLogsButton.disabled = true;
    rawLogsButton.textContent = "View raw logs";
    actions.append(timestampsButton, rawLogsButton);
    searchPlaceholder.after(actions);
    search.remove();

    const toggleTimestamps = (): void => {
      timestampsShown = !timestampsShown;
      document.querySelector<HTMLElement>(APP_SELECTOR)?.toggleAttribute(
        "data-gha-show-timestamps",
        timestampsShown,
      );
      timestampsButton.textContent = timestampsShown ? "Hide timestamps" : "Show timestamps";
    };
    const openRawLogs = (): void => {
      if (rawLogsUrl) window.open(rawLogsUrl, "_blank", "noopener,noreferrer");
    };
    timestampsButton.addEventListener("click", toggleTimestamps);
    rawLogsButton.addEventListener("click", openRawLogs);
    extensionGlobal.GHAPlusPlusReactApp?.mount(
      logContainer,
      stepsUrl,
      onInitialLogsComplete,
      (url) => {
        rawLogsUrl = url;
        rawLogsButton.disabled = !url;
      },
    );

    return {
      dispose(): void {
        timestampsButton.removeEventListener("click", toggleTimestamps);
        rawLogsButton.removeEventListener("click", openRawLogs);
        removeMountedApps();
        logContainer.replaceChildren(nativeLogContents);
        actions.remove();
        searchPlaceholder.replaceWith(search);
      },
    };
  }

  async function mountJobLogApp(expectedUrl: string, generation: number): Promise<void> {
    const stepsElement = await waitForElement<HTMLElement>("[data-job-steps-url]");
    const stepsUrl = stepsElement?.getAttribute("data-job-steps-url");
    if (!stepsUrl) throw new Error("Unable to find GitHub Actions steps URL");

    const [search, logContainer] = await Promise.all([
      waitForElement<HTMLElement>(".js-check-run-search"),
      waitForElement<HTMLElement>(".js-full-logs-container"),
    ]);
    if (!search) throw new Error("Unable to find GitHub Actions log search");
    if (!logContainer) throw new Error("Unable to find GitHub Actions log container");
    if (generation !== navigationGeneration || location.href !== expectedUrl) return;

    activeJobLog = replaceNativeLog(search, logContainer, stepsUrl, () => {
      if (generation !== navigationGeneration || location.href !== expectedUrl) return;
      initialLogFetchesComplete = true;
      removeScrollRestorationFloor();
    });
  }

  async function handleNavigation({ url }: NavigationEvent): Promise<void> {
    const generation = ++navigationGeneration;
    disposeActiveJobLog();
    if (url.hostname !== "github.com" || !JOB_PATH.test(url.pathname)) {
      scrollRestorationFloor?.remove();
      scrollRestorationFloor = null;
      return;
    }
    if (!await viewerEnabled()) {
      scrollRestorationFloor?.remove();
      scrollRestorationFloor = null;
      return;
    }
    if (generation !== navigationGeneration || location.href !== url.href) return;
    await mountJobLogApp(url.href, generation);
    if (generation !== navigationGeneration || location.href !== url.href) return;
  }

  onNavigation(handleNavigation);
  extensionChrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !(ENABLED_SETTING in changes)) return;
    void handleNavigation({ url: new URL(location.href), previousUrl: null });
  });
})();
