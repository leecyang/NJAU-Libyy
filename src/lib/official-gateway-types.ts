export type OfficialGatewayLane = "READ" | "WRITE" | "PLAYWRIGHT";
export type OfficialGatewayJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type OfficialGatewayJobKind =
  | "ROOMS_REFRESH"
  | "RESERVATIONS_REFRESH"
  | "USER_SCORE_REFRESH"
  | "TEAM_SCORES_REFRESH"
  | "OFFICIAL_USER_SEARCH"
  | "MANUAL_RESERVATION"
  | "CANCEL_RESERVATION"
  | "CREATE_SIGN_LINK"
  | "SIGNOUT_RESERVATION";

export type OfficialGatewayJob = {
  id: string;
  kind: OfficialGatewayJobKind;
  lane: OfficialGatewayLane;
  ownerUserId: string | null;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  status: OfficialGatewayJobStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  availableAt: number;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
};

export type OfficialGatewaySnapshot<T = unknown> = {
  key: string;
  scope: "GLOBAL" | "USER";
  ownerUserId: string | null;
  kind: string;
  value: T;
  version: number;
  freshUntil: number;
  staleUntil: number;
  refreshedAt: number;
  refreshJobId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  freshness: "FRESH" | "STALE" | "EXPIRED";
};

export type EnqueueOfficialGatewayJob = {
  kind: OfficialGatewayJobKind;
  lane: OfficialGatewayLane;
  ownerUserId?: string | null;
  dedupeKey?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  availableAt?: number;
};

export type WriteOfficialGatewaySnapshot<T> = {
  key: string;
  scope: "GLOBAL" | "USER";
  ownerUserId?: string | null;
  kind: string;
  value: T;
  freshForMs: number;
  staleForMs: number;
  refreshJobId?: string | null;
};

export type OfficialRequestMode = "READ" | "WRITE";
export type OfficialGatewayJobHandler = (job: OfficialGatewayJob) => Promise<unknown>;

export interface OfficialAccessGateway {
  initialize(): Promise<void>;
  registerHandler(kind: OfficialGatewayJobKind, handler: OfficialGatewayJobHandler): void;
  enqueue(input: EnqueueOfficialGatewayJob): Promise<OfficialGatewayJob>;
  getJob(jobId: string): Promise<OfficialGatewayJob | null>;
  waitForJob(jobId: string, timeoutMs: number): Promise<OfficialGatewayJob>;
  readSnapshot<T>(key: string): Promise<OfficialGatewaySnapshot<T> | null>;
  writeSnapshot<T>(input: WriteOfficialGatewaySnapshot<T>): Promise<OfficialGatewaySnapshot<T>>;
  linkSnapshotRefresh(key: string, jobId: string): Promise<void>;
  markSnapshotError(key: string, jobId: string | null, code: string, message: string): Promise<void>;
  runOfficialRequest<T>(key: string, mode: OfficialRequestMode, operation: () => Promise<T>): Promise<T>;
  runPlaywright<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export function publicGatewayJob(job: OfficialGatewayJob): Record<string, unknown> {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    result: job.result,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
  };
}
