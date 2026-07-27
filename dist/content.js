"use strict";
(() => {
    "use strict";
    const JOB_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+\/?$/;
    const extensionChrome = globalThis.chrome;
    const APP_SELECTOR = "[data-gha-plusplus-app]";
    /**
     * A persistent parser worker for one log step. The extension-origin iframe
     * is required because GitHub's page cannot construct extension workers.
     */
    class StepLogWorker {
        host;
        hostOrigin;
        ready;
        resolveReady;
        rejectReady;
        result = null;
        resolveResult = null;
        rejectResult = null;
        disposed = false;
        constructor(logUrl) {
            const hostUrl = extensionChrome.runtime.getURL("worker-host.html");
            this.hostOrigin = new URL(hostUrl).origin;
            this.host = document.createElement("iframe");
            this.host.hidden = true;
            this.host.src = hostUrl;
            this.ready = new Promise((resolve, reject) => {
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
        static async create(logUrl) {
            const worker = new StepLogWorker(logUrl);
            await worker.ready;
            return worker;
        }
        getLines() {
            return this.getResult().then((result) => result.elements);
        }
        getLength() {
            return this.getResult().then((result) => result.length);
        }
        dispose() {
            if (this.disposed)
                return;
            this.disposed = true;
            this.post({ type: "dispose" });
            this.host.remove();
            window.removeEventListener("message", this.handleMessage);
            this.fail(new Error("Log parser worker was disposed"));
        }
        getResult() {
            if (this.disposed) {
                return Promise.reject(new Error("Log parser worker was disposed"));
            }
            if (this.result)
                return this.result;
            this.result = new Promise((resolve, reject) => {
                this.resolveResult = resolve;
                this.rejectResult = reject;
                this.post({ type: "get-lines" });
            });
            return this.result;
        }
        post(message) {
            this.host.contentWindow?.postMessage(message, this.hostOrigin);
        }
        handleMessage = (event) => {
            if (event.source !== this.host.contentWindow || event.origin !== this.hostOrigin)
                return;
            const message = event.data;
            if (message.type === "initialized") {
                this.resolveReady();
            }
            else if (message.type === "lines") {
                this.resolveResult?.({
                    elements: message.elements ?? [],
                    length: message.length ?? 0,
                });
                this.resolveResult = null;
                this.rejectResult = null;
            }
            else if (message.type === "error") {
                this.fail(new Error(message.error ?? "Unknown log parser error"));
            }
        };
        fail(error) {
            this.rejectReady(error);
            this.rejectResult?.(error);
            this.resolveResult = null;
            this.rejectResult = null;
        }
    }
    function waitForElement(selector, timeoutMs = 5000) {
        const existing = document.querySelector(selector);
        if (existing)
            return Promise.resolve(existing);
        return new Promise((resolve) => {
            const observer = new MutationObserver(() => {
                const element = document.querySelector(selector);
                if (!element)
                    return;
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
    function onNavigation(callback) {
        let deliveredUrl = null;
        let scheduled = false;
        const deliver = () => {
            scheduled = false;
            const nextUrl = location.href;
            if (nextUrl === deliveredUrl)
                return;
            const previousUrl = deliveredUrl ? new URL(deliveredUrl) : null;
            deliveredUrl = nextUrl;
            callback({ url: new URL(nextUrl), previousUrl });
        };
        // Coalesce history, Turbo, Navigation API, and DOM signals generated by a
        // single GitHub navigation into one callback at the next rendered frame.
        const schedule = () => {
            if (scheduled || location.href === deliveredUrl)
                return;
            scheduled = true;
            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", deliver, { once: true });
            }
            else {
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
        const navigation = window.navigation;
        navigation?.addEventListener("navigatesuccess", schedule);
        // Fallback for GitHub navigation mechanisms that do not emit a public
        // event. Mutations only trigger a URL comparison; callback remains deduped.
        const observer = new MutationObserver(schedule);
        observer.observe(document, { childList: true, subtree: true });
        schedule();
        return () => {
            observer.disconnect();
            for (const eventName of eventNames) {
                window.removeEventListener(eventName, schedule, true);
            }
            navigation?.removeEventListener("navigatesuccess", schedule);
        };
    }
    function JobLogApp({ stepsUrl }) {
        const [state, setState] = React.useState({ status: "loading" });
        React.useEffect(() => {
            let cancelled = false;
            const workers = new Set();
            async function loadSteps() {
                setState({ status: "loading" });
                const stepsRequest = await fetch(stepsUrl, {
                    headers: { "Accept": "application/json" },
                });
                if (!stepsRequest.ok) {
                    throw new Error(`Steps request failed with HTTP ${stepsRequest.status}`);
                }
                const rawSteps = await stepsRequest.json();
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
                if (!cancelled)
                    setState({ status: "ready", steps });
            }
            loadSteps().catch((error) => {
                if (cancelled)
                    return;
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
        let body;
        if (state.status === "loading") {
            body = React.createElement("div", { className: "gha-muted" }, "Loading GitHub Actions log data…");
        }
        else if (state.status === "error") {
            body = React.createElement("div", { className: "gha-error" }, state.message);
        }
        else {
            body = React.createElement("div", { className: "gha-muted" }, `Loaded ${state.steps.length} step${state.steps.length === 1 ? "" : "s"}.`);
        }
        return React.createElement(React.Fragment, null, style, React.createElement("div", { className: "gha-root" }, React.createElement("div", { className: "gha-title" }, "GHA++"), body));
    }
    function removeMountedApps() {
        document.querySelectorAll(APP_SELECTOR).forEach((host) => {
            const mountPoint = host.shadowRoot?.firstElementChild;
            if (mountPoint instanceof HTMLElement) {
                ReactDOM.unmountComponentAtNode(mountPoint);
            }
            host.remove();
        });
    }
    async function mountJobLogApp() {
        const stepsElement = await waitForElement("[data-job-steps-url]");
        const stepsUrl = stepsElement
            ?.getAttribute("data-job-steps-url");
        if (!stepsUrl)
            throw new Error("Unable to find GitHub Actions steps URL");
        const container = await waitForElement(".js-full-logs-container");
        if (!container)
            throw new Error("Unable to find GitHub Actions log container");
        removeMountedApps();
        const host = document.createElement("div");
        host.dataset.ghaPlusplusApp = "";
        const shadow = host.attachShadow({ mode: "open" });
        const mountPoint = document.createElement("div");
        shadow.append(mountPoint);
        container.append(host);
        ReactDOM.render(React.createElement(JobLogApp, { stepsUrl }), mountPoint);
    }
    async function handleNavigation({ url }) {
        if (url.hostname !== "github.com" || !JOB_PATH.test(url.pathname)) {
            removeMountedApps();
            return;
        }
        await mountJobLogApp();
    }
    onNavigation(handleNavigation);
})();
//# sourceMappingURL=content.js.map