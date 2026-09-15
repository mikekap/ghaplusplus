(() => {
  "use strict";

  const NativeSharedWorker = window.SharedWorker;
  const SOCKET_CHANNEL_SELECTOR = [
    "check-steps[data-channel]",
    ".js-socket-channel[data-channel]",
  ].join(", ");
  const stepLogSubscribers = new Set<string>();
  const githubWorkerErrors = new BroadcastChannel("shared-worker-error");
  let brokerPort: MessagePort | undefined;
  let actionsResultsTopic: GitHubSocketTopic | undefined;
  let githubConnected = false;
  let subscribedTopic: string | undefined;

  console.log("[GHA++ live] bridge loaded");

  githubWorkerErrors.onmessage = (event): void => {
    console.error("[GHA++ live] GitHub SharedWorker error", event.data);
  };

  function handleGitHubEvent(event: MessageEvent<GitHubSocketEvent>): void {
    const message = event.data;
    console.log("[GHA++ live] GitHub port message", JSON.stringify(message));
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
      console.log("[GHA++ live] publishing step log", {
        stepId: log.stepId,
        startLine: log.startLine,
        lines: log.lines.length,
      });
      window.postMessage({
        type: "gha-plusplus-step-log",
        event: log,
      } satisfies LiveBrokerEvent, location.origin);
    } else {
      console.log("[GHA++ live] no subscriber for step log", {
        stepId: log.stepId,
        lines: log.lines.length,
      });
    }
  }

  function subscribeToActionsResults(): void {
    console.log("[GHA++ live] considering GitHub subscription", JSON.stringify({
      githubConnected,
      hasBrokerPort: Boolean(brokerPort),
      topic: actionsResultsTopic,
      alreadySubscribed: subscribedTopic,
    }));
    if (!githubConnected || !brokerPort || !actionsResultsTopic) return;
    if (subscribedTopic === actionsResultsTopic.signed) return;
    const command = { subscribe: [actionsResultsTopic] };
    console.log("[GHA++ live] broker port send", JSON.stringify(command));
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
    console.log("[GHA++ live] socket data-channel", JSON.stringify(signedTopics));
    const topics = signedTopics.map(parseTopic);
    console.log("[GHA++ live] decoded socket topics", JSON.stringify(topics));
    const topic = topics
      .find(({ name }) => name.startsWith("actions_results:"));
    if (!topic || topic.signed === actionsResultsTopic?.signed) return;
    actionsResultsTopic = topic;
    console.log("[GHA++ live] captured GitHub actions results topic", JSON.stringify(topic));
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
      console.log("[GHA++ live] GitHub client port send", JSON.stringify(message));
      Reflect.apply(postMessage, this, arguments);
      if (!(message && typeof message === "object" && "connect" in message)) return;
      console.log("[GHA++ live] observed GitHub connect");
      console.log("[GHA++ live] broker port send", JSON.stringify(message));
      brokerWorker.port.postMessage(message);
      githubConnected = true;
      subscribeToActionsResults();
    };
    githubWorker.port.addEventListener("message", (event): void => {
      console.log("[GHA++ live] GitHub client port receive", JSON.stringify(event.data));
    });
    githubWorker.port.start();
    brokerWorker.port.addEventListener("message", handleGitHubEvent);
    brokerWorker.port.addEventListener("messageerror", (event): void => {
      console.error("[GHA++ live] broker port message error", event);
    });
    brokerWorker.addEventListener("error", (event): void => {
      console.error("[GHA++ live] GitHub SharedWorker load error", event);
    });
    brokerWorker.port.start();
    console.log("[GHA++ live] broker connected to GitHub SharedWorker");
  }

  window.SharedWorker = new Proxy(NativeSharedWorker, {
    construct(target, args, newTarget) {
      window.SharedWorker = NativeSharedWorker;
      const worker = Reflect.construct(target, args, newTarget) as SharedWorker;
      const brokerWorker = Reflect.construct(target, args, target) as SharedWorker;
      console.log("[GHA++ live] captured GitHub SharedWorker constructor", JSON.stringify(args));
      startBroker(worker, brokerWorker);
      return worker;
    },
  });

  window.addEventListener("message", (event: MessageEvent<SubscribeLiveBrokerMessage>) => {
    if (event.data?.type !== "gha-plusplus-subscribe-step-log") return;
    console.log("[GHA++ live] broker received", JSON.stringify(event.data));
    stepLogSubscribers.add(event.data.stepId);
  });
})();
