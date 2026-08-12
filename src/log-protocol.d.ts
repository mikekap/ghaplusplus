interface GitHubJobStep {
  id?: string;
  log_url: string | null;
  name?: string;
  number?: number;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface RenderedChunk {
  html: string;
  rows: number;
  estimatedHeight: number;
}

interface RenderedLog {
  chunks: RenderedChunk[];
  complete: boolean;
  wrapColumns: number;
}

interface RenderSplice {
  index: number;
  deleteCount: number;
  chunks: RenderedChunk[];
}

interface InitializeLogSourceMessage {
  type: "initialize-source";
  step: GitHubJobStep;
  stepsUrl: string;
}

interface CreateLogViewMessage {
  type: "create-view";
  wrapColumns: number;
}

type LogWorkerMessage = InitializeLogSourceMessage | CreateLogViewMessage;

type LogViewCommand =
  | { type: "load" }
  | { type: "fetch-previous" }
  | { type: "set-wrap-columns"; wrapColumns: number };

/** Incremental update sent from a worker LogView to its client. */
type LogViewEvent =
  | {
    type: "render";
    revision: number;
    splice: RenderSplice;
    complete: boolean;
    wrapColumns: number;
  }
  | { type: "error"; message: string };
