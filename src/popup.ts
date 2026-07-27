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
  if (!element) throw new Error(`GHA++ popup is missing ${selector}`);
  return element;
}

const toggle = requiredElement<HTMLButtonElement>("#toggle");

function render(enabled: boolean): void {
  toggle.textContent = enabled ? "Disable GHA++" : "Enable GHA++";
}

async function load(): Promise<boolean> {
  const settings = await extensionChrome.storage.sync.get({ [ENABLED_SETTING]: true });
  return settings[ENABLED_SETTING] ?? true;
}

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  const nextEnabled = !(await load());
  await extensionChrome.storage.sync.set({ [ENABLED_SETTING]: nextEnabled });
  render(nextEnabled);
  toggle.disabled = false;
});

void load().then(render);
