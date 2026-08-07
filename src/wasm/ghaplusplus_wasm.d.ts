export default function init(options: {
  module_or_path: URL;
}): Promise<unknown>;

export class LogSource {
  constructor(url: string);
  create_view(wrapColumns: number): LogView;
  fetch(): Promise<void>;
  fetch_previous(): Promise<void>;
  free(): void;
}

export class LogView {
  private constructor();
  initialize_window(): unknown;
  expand_to_source_start(): unknown;
  set_wrap_columns(wrapColumns: number): unknown;
  free(): void;
}

export class LogParser {
  constructor(discardFirstLine: boolean);
  push(chunk: Uint8Array): unknown[];
  finish(): unknown[];
  free(): void;
}
