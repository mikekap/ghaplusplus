(() => {
  "use strict";

  const JOB_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+\/?$/;
  const APP_SELECTOR = "[data-gha-plusplus-app]";
  const ENABLED_SETTING = "viewerEnabled";
  let activeJobLog: { dispose(): void } | null = null;
  let navigationGeneration = 0;

  interface NavigationEvent {
    url: URL;
    previousUrl: URL | null;
  }

  type NavigationCallback = (navigation: NavigationEvent) => void;
  type WindowWithNavigation = Window & { navigation?: EventTarget };

  interface ChromeStorage {
    sync: {
      get(defaults: Record<string, boolean>): Promise<Record<string, boolean>>;
      set(items: Record<string, boolean>): Promise<void>;
    };
    onChanged: {
      addListener(listener: (changes: Record<string, { newValue?: boolean }>, areaName: string) => void): void;
    };
  }

  interface GHAPlusPlusReactApp {
    mount(
      search: HTMLElement,
      logContainer: HTMLElement,
      stepsUrl: string,
    ): void;
    unmount(host: HTMLElement): void;
  }

  const extensionChrome = (
    globalThis as typeof globalThis & { chrome: { storage: ChromeStorage } }
  ).chrome;
  const extensionGlobal = globalThis as typeof globalThis & {
    GHAPlusPlusReactApp?: GHAPlusPlusReactApp;
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
  }

  async function viewerEnabled(): Promise<boolean> {
    const settings = await extensionChrome.storage.sync.get({ [ENABLED_SETTING]: true });
    return settings[ENABLED_SETTING] ?? true;
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

    extensionGlobal.GHAPlusPlusReactApp?.mount(search, logContainer, stepsUrl);
    activeJobLog = { dispose: removeMountedApps };
  }

  async function handleNavigation({ url }: NavigationEvent): Promise<void> {
    const generation = ++navigationGeneration;
    disposeActiveJobLog();
    if (url.hostname !== "github.com" || !JOB_PATH.test(url.pathname)) return;
    if (!await viewerEnabled()) return;
    if (generation !== navigationGeneration || location.href !== url.href) return;
    await mountJobLogApp(url.href, generation);
    if (generation !== navigationGeneration || location.href !== url.href) return;
  }

  onNavigation(handleNavigation);
  extensionChrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !(ENABLED_SETTING in changes)) return;
    location.reload();
  });
})();
