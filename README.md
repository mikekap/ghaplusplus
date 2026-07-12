# GHA++

A small Chrome extension for modifying GitHub Actions job pages.

The initial behavior clears the contents of GitHub's
`.js-full-logs-container` on URLs shaped like:

```text
https://github.com/<owner>/<repo>/actions/runs/<run-id>/job/<job-id>
```

The content script loads on every `github.com` page, then responds to GitHub's
client-side navigation and only modifies matching Actions job routes. Multiple
signals from one soft navigation are coalesced, and `handleNavigation` runs
exactly once for the initial URL and once for each subsequent URL transition.

## Install for development

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository directory.

Install dependencies and compile the TypeScript source before loading the
extension:

```sh
npm install
npm run build
```

The build also requires Rust, the `wasm32-unknown-unknown` target, and
`wasm-pack`.

Source code lives in `src/`; Chrome loads the compiled `dist/content.js`.
After rebuilding, reload the extension from `chrome://extensions`, then refresh
the GitHub tab. Use `npm run watch` while developing to rebuild on changes.
