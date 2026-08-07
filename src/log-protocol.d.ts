interface RenderedChunk {
  html: string;
  rows: number;
  estimatedHeight: number;
}

interface RenderedLog {
  chunks: RenderedChunk[];
  length: number;
  complete: boolean;
  wrapColumns: number;
}

interface RenderSplice {
  index: number;
  deleteCount: number;
  chunks: RenderedChunk[];
}

interface CreateLogViewMessage {
  type: "create-view";
  logUrl: string;
  wrapColumns: number;
}

type LogViewCommand =
  | { type: "load" }
  | { type: "fetch-previous" }
  | { type: "set-wrap-columns"; wrapColumns: number };

/** Incremental update sent from a worker LogView to its React callback. */
type LogViewEvent =
  | {
    type: "render";
    revision: number;
    splice: RenderSplice;
    length: number;
    complete: boolean;
    wrapColumns: number;
  }
  | { type: "error"; message: string };

interface StepLogViewHandle {
  load(): Promise<void>;
  fetchPrevious(): void;
  setWrapColumns(wrapColumns: number): void;
  close(): void;
}

interface StepLogSourceHandle {
  createView(
    wrapColumns: number,
    listener: (event: LogViewEvent) => void,
  ): Promise<StepLogViewHandle>;
}
