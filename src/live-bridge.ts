(() => {
  "use strict";

  const NativeSharedWorker = window.SharedWorker;
  const stepLogSubscribers = new Map<string, Set<MessagePort>>();
  let githubWorker: SharedWorker;
  let topics: GitHubSocketTopic[];

  function handleGitHubEvent(event: MessageEvent<GitHubSocketEvent>): void {
    const message = event.data;
    if (
      message.type !== "message"
      || !message.channel.startsWith("actions_results:")
      || message.data.kind !== 0
    ) return;
    const log = message.data.data as GitHubLiveLogEvent;
    stepLogSubscribers.get(log.stepId)?.forEach((port) => {
      port.postMessage({ type: "step-log", event: log } satisfies LiveBrokerEvent);
    });
  }

  function startBroker(args: ConstructorParameters<typeof SharedWorker>): void {
    const socket = document.querySelector<HTMLLinkElement>('link[rel="shared-web-socket"]')!;
    githubWorker = new NativeSharedWorker(...args);
    githubWorker.port.onmessage = handleGitHubEvent;
    githubWorker.port.postMessage({
      connect: {
        url: socket.href,
        refreshUrl: socket.dataset.refreshUrl,
        options: {},
      },
    });
    if (topics) githubWorker.port.postMessage({ subscribe: topics });
    githubWorker.port.start();
  }

  window.SharedWorker = new Proxy(NativeSharedWorker, {
    construct(target, args, newTarget) {
      window.SharedWorker = NativeSharedWorker;
      const worker = Reflect.construct(target, args, newTarget);
      startBroker(args as ConstructorParameters<typeof SharedWorker>);
      return worker;
    },
  });

  function parseTopic(signed: string): GitHubSocketTopic {
    const { c: name, t: offset } = JSON.parse(
      window.atob(signed.split("--", 1)[0]),
    ) as { c: string; t: number };
    return { name, signed, offset };
  }

  function captureTopics(steps: Element): void {
    topics = steps.getAttribute("data-channel")!.trim().split(/\s+/).map(parseTopic);
    if (githubWorker) githubWorker.port.postMessage({ subscribe: topics });
  }

  const existingSteps = document.querySelector("check-steps[data-channel]");
  if (existingSteps) captureTopics(existingSteps);
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        const steps = node.matches("check-steps[data-channel]")
          ? node
          : node.querySelector("check-steps[data-channel]");
        if (steps) captureTopics(steps);
      });
    }
  }).observe(document, { childList: true, subtree: true });

  window.addEventListener("message", (event: MessageEvent<ConnectLiveBrokerMessage>) => {
    if (event.data?.type !== "gha-plusplus-connect-live-broker") return;
    const client = event.ports[0];
    client.onmessage = (event: MessageEvent<LiveBrokerCommand>): void => {
      const command = event.data;
      if (command.type !== "subscribe-step-log") return;
      let subscribers = stepLogSubscribers.get(command.stepId);
      if (!subscribers) {
        subscribers = new Set();
        stepLogSubscribers.set(command.stepId, subscribers);
      }
      subscribers.add(client);
    };
    client.start();
  });
})();
