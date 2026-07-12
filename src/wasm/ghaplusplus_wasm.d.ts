export default function init(options: {
  module_or_path: URL;
}): Promise<unknown>;

export type LogElement =
  | { Line: [timestampMs: number, html: string] }
  | { Group: [timestampMs: number, html: string, children: LogElement[]] };

export class LogParser {
  constructor(discardFirstLine: boolean);
  push(chunk: Uint8Array): LogElement[];
  finish(): LogElement[];
  free(): void;
}
