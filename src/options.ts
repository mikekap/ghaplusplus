export {};

const ENABLED_SETTING = "viewerEnabled";

interface ChromeStorage {
  sync: {
    get(defaults: Record<string, boolean>): Promise<Record<string, boolean>>;
    set(items: Record<string, boolean>): Promise<void>;
  };
}

const extensionChrome = (globalThis as typeof globalThis & {
  chrome: { storage: ChromeStorage };
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
