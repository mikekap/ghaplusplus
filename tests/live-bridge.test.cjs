const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const scripts = Object.fromEntries(['content', 'live-bridge'].map(name => [name,
  ts.transpileModule(fs.readFileSync(`${__dirname}/../src/${name}.ts`, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
]));

function harness() {
  const workers = [], observers = [], messages = [], listeners = new Map();
  const topicName = 'actions_results:run:job';
  const signed = Buffer.from(JSON.stringify({ c: topicName })).toString('base64') + '--signature';
  let resolveSettings, settingsChanged, queries = 0, prepared = 0, reloads = 0;
  const settings = new Promise(resolve => { resolveSettings = resolve; });

  class Port {
    sent = [];
    listeners = new Map();
    started = false;
    postMessage(message) { this.sent.push(message); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    start() { this.started = true; }
    receive(data) { this.listeners.get('message')?.({ data }); }
  }
  class SharedWorker {
    port = new Port();
    constructor(...args) { this.args = args; workers.push(this); }
  }
  class Element {
    matches() { return true; }
    getAttribute() { return signed; }
    querySelectorAll() { return []; }
  }
  const topic = new Element();
  const location = {
    origin: 'https://github.com', hostname: 'github.com', pathname: '/owner/repo',
    href: 'https://github.com/owner/repo', reload() { reloads++; },
  };
  const queue = [];
  const window = {
    SharedWorker,
    atob: value => Buffer.from(value, 'base64').toString(),
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    postMessage(data) {
      messages.push(data);
      queue.push(() => {
        for (const callback of [...(listeners.get('message') ?? [])]) {
          callback({ data, source: window, origin: location.origin });
        }
      });
    },
  };
  const context = vm.createContext({
    window, location, URL, Element,
    document: {
      readyState: 'complete',
      querySelectorAll() { queries++; return [topic]; },
    },
    requestAnimationFrame: callback => queue.push(callback),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.push(this); }
    },
    chrome: { storage: {
      sync: { get: () => settings },
      onChanged: { addListener(callback) { settingsChanged = callback; } },
    } },
    GHAPlusPlusReactApp: {
      prepareScrollRestoration() {
        assert.ok(queries > 0, 'topics are captured before React can replace GitHub markup');
        prepared++;
      },
      unmount() {},
      mount() { throw new Error('Not on a job page'); },
    },
    console: { error() { assert.fail('Unexpected error'); } },
  });
  return {
    window, workers, observers, messages, topicName, signed, Port, SharedWorker,
    connect: { connect: { url: 'wss://alive.github.com/test', refreshUrl: '/_alive', options: {} } },
    run(name) { vm.runInContext(scripts[name], context); },
    setEnabled(value) { resolveSettings({ viewerEnabled: value }); },
    changeEnabled(value) { settingsChanged({ viewerEnabled: { newValue: value } }, 'sync'); },
    get queries() { return queries; },
    get prepared() { return prepared; },
    get reloads() { return reloads; },
    async flush() {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        while (queue.length) queue.shift()();
      }
    },
  };
}

for (const timing of ['before-worker', 'before-connect', 'after-connect']) {
  test(`disabled: settings arrive ${timing}`, async () => {
    const h = harness();
    h.run('live-bridge');
    h.run('content');
    let original;
    if (timing !== 'before-worker') original = new h.window.SharedWorker('github-worker.js');
    if (timing === 'after-connect') original.port.postMessage(h.connect);
    h.setEnabled(false);
    await h.flush();
    assert.equal(h.window.SharedWorker, h.SharedWorker);
    if (!original) original = new h.window.SharedWorker('github-worker.js');
    assert.equal(original.port.postMessage, h.Port.prototype.postMessage);
    if (timing !== 'after-connect') original.port.postMessage(h.connect);
    await h.flush();
    assert.deepEqual(original.port.sent, [h.connect]);
    assert.equal(h.workers.length, 1, 'only GitHub creates a worker');
    assert.equal(h.queries, 0, 'no socket-topic reads');
    assert.equal(h.observers.length, 0, 'no topic or navigation observer');
    assert.equal(h.prepared, 0, 'no scroll-protection CSS');
    h.changeEnabled(true);
    assert.equal(h.reloads, 1, 'reenabling reloads the page');
  });
}

for (const contentFirst of [false, true]) {
  for (const connectFirst of [false, true]) {
    test(`enabled: contentFirst=${contentFirst}, connectFirst=${connectFirst}`, async () => {
      const h = harness();
      if (contentFirst) {
        h.run('content');
        h.setEnabled(true);
        await h.flush(); // Initial settings message precedes the bridge listener.
      }
      h.run('live-bridge');
      if (!contentFirst) h.run('content');
      const original = new h.window.SharedWorker('github-worker.js', { name: 'socket', type: 'module' });
      if (connectFirst) original.port.postMessage(h.connect);
      if (!contentFirst) {
        await h.flush();
        assert.equal(h.workers.length, 1, 'no broker while settings are unresolved');
        assert.equal(h.queries, 0);
        h.setEnabled(true);
      }
      await h.flush();
      assert.equal(h.prepared, 1, 'viewer starts without waiting for the socket connection');
      if (!connectFirst) original.port.postMessage(h.connect);
      await h.flush();
      assert.equal(h.workers.length, 2);
      const broker = h.workers[1];
      assert.deepEqual(broker.args, original.args);
      assert.equal(original.port.postMessage, h.Port.prototype.postMessage);
      assert.equal(original.port.listeners.size, 0);
      assert.equal(broker.port.started, true);
      assert.equal(broker.port.sent[0], h.connect);
      assert.equal(broker.port.sent[1].subscribe[0].signed, h.signed);
      assert.equal(broker.port.sent.length, 2);
      h.window.postMessage({ type: 'gha-plusplus-subscribe-step-log', stepId: 'step' });
      await h.flush();
      const log = { stepId: 'step', startLine: 1, lines: [{ lineID: '1-1', line: 'output' }] };
      broker.port.receive({ type: 'message', channel: h.topicName, data: { kind: 0, data: log } });
      broker.port.receive({ type: 'message', channel: h.topicName, data: { kind: 1 } });
      assert.equal(h.messages.find(message => message.type === 'gha-plusplus-step-log').event, log);
      assert.ok(h.messages.some(message => message.type === 'gha-plusplus-steps-changed'));
      h.changeEnabled(false);
      assert.equal(h.reloads, 1, 'disabling reloads to tear down the broker');
    });
  }
}
