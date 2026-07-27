export default function init(options: {
  module_or_path: URL;
}): Promise<unknown>;

export class LogSession {
  constructor(url: string);
  fetch(wrapColumns: number): Promise<unknown>;
  fetch_previous(wrapColumns: number): Promise<unknown>;
  rewrap(wrapColumns: number): unknown;
  free(): void;
}

export class LogParser {
  constructor(discardFirstLine: boolean);
  push(chunk: Uint8Array): unknown[];
  finish(): unknown[];
  free(): void;
}
