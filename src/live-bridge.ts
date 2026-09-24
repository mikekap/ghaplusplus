(() => {
  "use strict";

  const NativeSharedWorker = window.SharedWorker;
  const SOCKET_CHANNEL_SELECTOR = [
    "check-steps[data-channel]",
    ".js-socket-channel[data-channel]",
  ].join(", ");
  const stepLogSubscribers = new Set<string>();
  let brokerPort: MessagePort | undefined;
  let actionsResultsTopic: GitHubSocketTopic | undefined;
  let githubConnected = false;
  let subscribedTopic: string | undefined;

  function handleGitHubEvent(event: MessageEvent<GitHubSocketEvent>): void {
    const message = event.data;
    if (
      message.type !== "message"
      || !message.channel.startsWith("actions_results:")
    ) return;
    if (message.data.kind === 1) {
      window.postMessage({
        type: "gha-plusplus-steps-changed",
        channel: message.channel,
      } satisfies LiveBrokerEvent, location.origin);
      return;
    }
    if (message.data.kind !== 0) return;
    const log = message.data.data as GitHubLiveLogEvent;
    if (stepLogSubscribers.has(log.stepId)) {
      window.postMessage({
        type: "gha-plusplus-step-log",
        event: log,
      } satisfies LiveBrokerEvent, location.origin);
    }
  }

  function subscribeToActionsResults(): void {
    if (!githubConnected || !brokerPort || !actionsResultsTopic) return;
    if (subscribedTopic === actionsResultsTopic.signed) return;
    const command = { subscribe: [actionsResultsTopic] };
    brokerPort.postMessage(command);
    subscribedTopic = actionsResultsTopic.signed;
  }

  function parseTopic(signed: string): GitHubSocketTopic {
    const { c: name } = JSON.parse(
      window.atob(signed.split("--", 1)[0]),
    ) as { c: string };
    return { name, signed, offset: "" };
  }

  function captureActionsResultsTopic(steps: Element): void {
    const signedTopics = steps.getAttribute("data-channel")!
      .trim()
      .split(/\s+/);
    const topics = signedTopics.map(parseTopic);
    const topic = topics
      .find(({ name }) => name.startsWith("actions_results:"));
    if (!topic || topic.signed === actionsResultsTopic?.signed) return;
    actionsResultsTopic = topic;
    subscribeToActionsResults();
  }

  function captureActionsResultsTopics(root: Document | Element): void {
    if (root instanceof Element && root.matches(SOCKET_CHANNEL_SELECTOR)) {
      captureActionsResultsTopic(root);
    }
    root.querySelectorAll(SOCKET_CHANNEL_SELECTOR).forEach(captureActionsResultsTopic);
  }

  captureActionsResultsTopics(document);
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        captureActionsResultsTopics(node);
      });
    }
  }).observe(document, { childList: true, subtree: true });

  function startBroker(githubWorker: SharedWorker, brokerWorker: SharedWorker): void {
    brokerPort = brokerWorker.port;
    const postMessage = githubWorker.port.postMessage;
    githubWorker.port.postMessage = function (message: unknown): void {
      Reflect.apply(postMessage, this, arguments);
      if (!(message && typeof message === "object" && "connect" in message)) return;
      brokerWorker.port.postMessage(message);
      githubConnected = true;
      subscribeToActionsResults();
    };
    brokerWorker.port.addEventListener("message", handleGitHubEvent);
    brokerWorker.port.start();
  }

  window.SharedWorker = new Proxy(NativeSharedWorker, {
    construct(target, args, newTarget) {
      window.SharedWorker = NativeSharedWorker;
      const worker = Reflect.construct(target, args, newTarget) as SharedWorker;
      const brokerWorker = Reflect.construct(target, args, target) as SharedWorker;
      startBroker(worker, brokerWorker);
      return worker;
    },
  });

  window.addEventListener("message", (event: MessageEvent<SubscribeLiveBrokerMessage>) => {
    if (event.data?.type !== "gha-plusplus-subscribe-step-log") return;
    stepLogSubscribers.add(event.data.stepId);
  });
})();
