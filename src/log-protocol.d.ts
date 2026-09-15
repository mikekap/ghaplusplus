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

interface GitHubLiveLogLine {
  lineID: string;
  line: string;
}

interface GitHubLiveLogEvent {
  stepId: string;
  startLine: number;
  lines: GitHubLiveLogLine[];
}

interface GitHubSocketTopic {
  name: string;
  signed: string;
  offset: string | number;
}

interface SubscribeLiveBrokerMessage {
  type: "gha-plusplus-subscribe-step-log";
  stepId: string;
}

interface LiveStepLogEvent {
  type: "gha-plusplus-step-log";
  event: GitHubLiveLogEvent;
}

interface LiveStepsChangedEvent {
  type: "gha-plusplus-steps-changed";
  channel: string;
}

type LiveBrokerEvent = LiveStepLogEvent | LiveStepsChangedEvent;

interface GitHubSocketEvent {
  channel: string;
  type: "message" | "presence";
  data: {
    kind?: number;
    data?: unknown;
  };
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

interface AppendLiveLogMessage {
  type: "append-live";
  event: GitHubLiveLogEvent;
}

type LogWorkerMessage = InitializeLogSourceMessage | CreateLogViewMessage | AppendLiveLogMessage;

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
