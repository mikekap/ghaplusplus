export default function init(options: {
  module_or_path: URL;
}): Promise<unknown>;

export class LogParser {
  constructor(discardFirstLine: boolean);
  push(chunk: Uint8Array): string[];
  finish(): string[];
  free(): void;
}
