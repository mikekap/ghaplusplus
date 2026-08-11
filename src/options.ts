export {};

const ENABLED_SETTING = "viewerEnabled";

const extensionChrome = (globalThis as typeof globalThis & {
  chrome: ExtensionChrome;
}).chrome;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`GHA++ options page is missing ${selector}`);
  return element;
}

const checkbox = requiredElement<HTMLInputElement>("#viewer-enabled");
const statusElement = requiredElement<HTMLElement>("#status");

async function load(): Promise<void> {
  const settings = await extensionChrome.storage.sync.get({ [ENABLED_SETTING]: true });
  checkbox.checked = settings[ENABLED_SETTING] ?? true;
}

checkbox.addEventListener("change", async () => {
  await extensionChrome.storage.sync.set({ [ENABLED_SETTING]: checkbox.checked });
  statusElement.textContent = "Saved.";
});

void load();
