# GHA++

A Chrome extension that replaces the GitHub Actions job log viewer with a
React interface backed by Rust/WebAssembly workers. Built to keep large logs
responsive and make live output easier to follow.

## Features

- Background log loading, with opened steps moved to the front of the queue.
- Collapsible steps that retain their rendered logs, with sticky headers and
  shortcuts to the top and bottom.
- ANSI colors, optional timestamps, and line numbers that stay out of copied text.
- Incremental loading of older output for completed logs.
- Backscroll and live output for running steps, plus step-status updates.
- A **Follow** toggle for live steps that keeps the latest output in view with
  a 10% viewport gap below the step. Following opens the step; only one step
  follows at a time. It stops on completion, collapse, or use of the navigation
  actions. Click **Following** to turn it off.
- A link to GitHub's raw logs and a popup toggle to enable or disable the viewer.

## Build and install

You need Chrome, Node.js with npm, and a Rust toolchain installed through rustup.
Make sure `cargo` and `rustup` are on your `PATH`. `wasm-pack` is included in the
npm dependencies.

```sh
git clone https://github.com/mikekap/ghaplusplus.git
cd ghaplusplus
npm ci
rustup target add wasm32-unknown-unknown
npm run build
```

Then load the extension:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the repository directory, not `dist/`.
3. Open a GitHub Actions job page while signed in to GitHub.

The viewer runs on job URLs shaped like:

```text
https://github.com/<owner>/<repo>/actions/runs/<run-id>/job/<job-id>
```

It also handles GitHub's navigation between job pages. Use the extension popup
or options page to toggle the viewer; changing the setting reloads GitHub tabs
where the content script is running. No personal access token is required.

## Development

```sh
npm run build                          # Build WASM, copy React, compile TypeScript
npm run check                          # Type-check without emitting files
npm run watch                          # Watch TypeScript changes only
cargo test --manifest-path wasm/Cargo.toml
```

Run a full build first. After editing Rust, run `npm run build:wasm` or the full
build again. After rebuilding, reload the extension in `chrome://extensions`
and refresh the GitHub page. Generated files in `dist/` are not committed.

## Continuous integration

[GitHub Actions](https://github.com/mikekap/ghaplusplus/actions/workflows/ci.yml)
runs Rust tests and builds the extension on pushes to `master` and pull requests.
You can also start it manually from the Actions tab.

Each successful run uploads a `ghaplusplus-<commit>` artifact. Download its ZIP
for the Chrome Web Store, or extract it and use **Load unpacked** in Chrome.
The archive contains the manifest, icons, HTML, and compiled JavaScript/WASM.

Pushes and manual runs on `master` also upload a signed `ghaplusplus.crx`.
Chrome packs the same staged files using the `CRX_PRIVATE_KEY` repository secret,
which keeps the CRX extension ID consistent across builds. The private key is
never included in either artifact; pull requests do not receive it.

Use the ZIP for Chrome Web Store submissions. The self-signed CRX is for
[distribution outside the store](https://developer.chrome.com/docs/extensions/how-to/distribute):
on Windows and macOS, installing self-hosted extensions requires enterprise
policies.

## How it works

| File | Responsibility |
| --- | --- |
| `src/content.ts` | Detects GitHub job pages and mounts the app. |
| `src/app.ts` | React UI, load prioritization, DOM-owning log clients, status refreshes, and following. |
| `src/live-bridge.ts` | Runs in GitHub's main world, captures SharedWorker configuration, and subscribes through its own port to live Actions events. |
| `src/worker-host.ts` | Relays messages through an extension iframe to a dedicated log worker. |
| `src/log-worker.ts` | Coordinates fetching, Rust log sources and views, and batched render updates. |
| `src/log-protocol.d.ts` | Shared TypeScript message definitions. |
| `wasm/src/lib.rs` | Log fetching, parsing, live-line deduplication, and HTML rendering. |

Completed logs are fetched in ranges. Running steps use GitHub's JSON backscroll
endpoint and receive live lines through the page bridge. Step-change events
trigger a metadata refresh while retaining existing log views.

The live bridge creates another connection to GitHub's existing SharedWorker
using the same script and name. It forwards GitHub's `connect` command followed
by an `actions_results` subscription on its own port. Live messages pass through
the app and extension iframe to the Rust-backed worker.

Historical protocol investigation is in [LIVE-SOCKET.md](LIVE-SOCKET.md).

## Debugging live output

The current development build emits verbose `[GHA++ live]` console logs for
subscriptions, incoming events, forwarding, and Rust appends. These include
signed subscription/session values and full log payloads; redact those before
sharing a dump publicly.

When troubleshooting, check the browser console for the outgoing broker
`connect` and `subscribe`, incoming GitHub messages, and worker append results.
A successful build verifies compilation, not live delivery from GitHub.
