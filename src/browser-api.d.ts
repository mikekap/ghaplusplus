interface ExtensionChrome {
  runtime: {
    getURL(path: string): string;
  };
  storage: {
    sync: {
      get(defaults: Record<string, boolean>): Promise<Record<string, boolean>>;
      set(items: Record<string, boolean>): Promise<void>;
    };
    onChanged: {
      addListener(
        listener: (
          changes: Record<string, { newValue?: boolean }>,
          areaName: string,
        ) => void,
      ): void;
    };
  };
}

interface GHAPlusPlusReactApp {
  mount(
    search: HTMLElement,
    logContainer: HTMLElement,
    stepsUrl: string,
  ): HTMLElement;
  unmount(host: HTMLElement): void;
}
