(() => {
  "use strict";

  const JOB_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+\/?$/;
  const ENABLED_SETTING = "viewerEnabled";
  let activeHost: HTMLElement | null = null;
  let navigationGeneration = 0;

  type NavigationCallback = (url: URL) => Promise<void>;
  type WindowWithNavigation = Window & { navigation?: EventTarget };

  const extensionChrome = (
    globalThis as typeof globalThis & { chrome: ExtensionChrome }
  ).chrome;
  const extensionGlobal = globalThis as typeof globalThis & {
    GHAPlusPlusReactApp?: GHAPlusPlusReactApp;
  };

  function currentNavigationHref(): string {
    const hashIndex = location.href.indexOf("#");
    return hashIndex < 0 ? location.href : location.href.slice(0, hashIndex);
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

  function onNavigation(callback: NavigationCallback): void {
    let deliveredUrl: string | null = null;
    let scheduled = false;

    const deliver = (): void => {
      scheduled = false;
      const url = new URL(currentNavigationHref());
      const nextUrl = url.href;
      if (nextUrl === deliveredUrl) return;

      deliveredUrl = nextUrl;
      void callback(url).catch(() => console.error("GHA++ navigation failed"));
    };
    const schedule = (): void => {
      if (scheduled || currentNavigationHref() === deliveredUrl) return;
      scheduled = true;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", deliver, { once: true });
      } else {
        requestAnimationFrame(deliver);
      }
    };

    const eventNames = ["turbo:load", "turbo:render", "pjax:end", "popstate"];
    eventNames.forEach((eventName) => window.addEventListener(eventName, schedule, true));
    const navigation = (window as WindowWithNavigation).navigation;
    navigation?.addEventListener("navigatesuccess", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document, { childList: true, subtree: true });
    schedule();
  }

  function disposeActiveJobLog(): void {
    if (!activeHost) return;
    extensionGlobal.GHAPlusPlusReactApp?.unmount(activeHost);
    activeHost = null;
  }

  async function viewerEnabled(): Promise<boolean> {
    const settings = await extensionChrome.storage.sync.get({ [ENABLED_SETTING]: true });
    return settings[ENABLED_SETTING] ?? true;
  }

  async function mountJobLogApp(expectedUrl: string, generation: number): Promise<void> {
    const [stepsElement, search, logContainer] = await Promise.all([
      waitForElement<HTMLElement>("[data-job-steps-url]"),
      waitForElement<HTMLElement>(".js-check-run-search"),
      waitForElement<HTMLElement>(".js-full-logs-container"),
    ]);
    const stepsUrl = stepsElement?.getAttribute("data-job-steps-url");
    if (!stepsUrl) throw new Error("Unable to find GitHub Actions steps URL");
    if (!search) throw new Error("Unable to find GitHub Actions log search");
    if (!logContainer) throw new Error("Unable to find GitHub Actions log container");
    if (generation !== navigationGeneration || currentNavigationHref() !== expectedUrl) return;

    const app = extensionGlobal.GHAPlusPlusReactApp;
    if (!app) throw new Error("GHA++ React app was not loaded");
    activeHost = app.mount(search, logContainer, stepsUrl);
  }

  async function handleNavigation(url: URL): Promise<void> {
    const generation = ++navigationGeneration;
    disposeActiveJobLog();
    if (url.hostname !== "github.com" || !JOB_PATH.test(url.pathname)) return;
    if (!await viewerEnabled()) return;
    if (generation !== navigationGeneration || currentNavigationHref() !== url.href) return;
    await mountJobLogApp(url.href, generation);
  }

  onNavigation(handleNavigation);
  extensionChrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !(ENABLED_SETTING in changes)) return;
    location.reload();
  });
})();
