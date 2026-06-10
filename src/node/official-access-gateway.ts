import type { AppEnv } from "../config";
import { HttpError } from "../lib/http";
import type {
  EnqueueOfficialGatewayJob,
  OfficialAccessGateway,
  OfficialGatewayJob,
  OfficialGatewayJobHandler,
  OfficialGatewayJobKind,
  OfficialGatewayLane,
  OfficialGatewaySnapshot,
  OfficialRequestMode,
  WriteOfficialGatewaySnapshot,
} from "../lib/official-gateway-types";

type JobRow = {
  id: string;
  kind: OfficialGatewayJobKind;
  lane: OfficialGatewayLane;
  owner_user_id: string | null;
  dedupe_key: string | null;
  payload_json: string;
  status: OfficialGatewayJob["status"];
  priority: number;
  attempt_count: number;
  max_attempts: number;
  available_at: number;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

type SnapshotRow = {
  cache_key: string;
  scope: "GLOBAL" | "USER";
  owner_user_id: string | null;
  kind: string;
  value_json: string;
  version: number;
  fresh_until: number;
  stale_until: number;
  refreshed_at: number;
  refresh_job_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type PendingOperation<T> = {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

class AsyncLane {
  private readonly queue: Array<PendingOperation<unknown>> = [];
  private active = 0;
  private lastStartedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly concurrency: number, private readonly minIntervalMs: number) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ operation, resolve, reject } as PendingOperation<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || this.active >= this.concurrency || !this.queue.length) return;
    const delay = Math.max(0, this.lastStartedAt + this.minIntervalMs - Date.now());
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, delay);
      this.timer.unref?.();
      return;
    }
    const pending = this.queue.shift()!;
    this.active += 1;
    this.lastStartedAt = Date.now();
    void pending.operation().then(pending.resolve, pending.reject).finally(() => {
      this.active -= 1;
      this.pump();
    });
    this.pump();
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jobFromRow(row: JobRow): OfficialGatewayJob {
  return {
    id: row.id,
    kind: row.kind,
    lane: row.lane,
    ownerUserId: row.owner_user_id,
    dedupeKey: row.dedupe_key,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    priority: row.priority,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    result: parseJson(row.result_json, null),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function snapshotFromRow<T>(row: SnapshotRow): OfficialGatewaySnapshot<T> {
  const now = Date.now();
  return {
    key: row.cache_key,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    kind: row.kind,
    value: parseJson<T>(row.value_json, null as T),
    version: row.version,
    freshUntil: row.fresh_until,
    staleUntil: row.stale_until,
    refreshedAt: row.refreshed_at,
    refreshJobId: row.refresh_job_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    freshness: now <= row.fresh_until ? "FRESH" : now <= row.stale_until ? "STALE" : "EXPIRED",
  };
}

export class NodeOfficialAccessGateway implements OfficialAccessGateway {
  private readonly handlers = new Map<OfficialGatewayJobKind, OfficialGatewayJobHandler>();
  private readonly singleFlights = new Map<string, Promise<unknown>>();
  private readonly runningJobs: Record<OfficialGatewayLane, number> = { READ: 0, WRITE: 0, PLAYWRIGHT: 0 };
  private readonly jobLimits: Record<OfficialGatewayLane, number>;
  private readonly officialReadLane: AsyncLane;
  private readonly officialWriteLane: AsyncLane;
  private readonly playwrightLane: AsyncLane;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;

  constructor(private readonly env: AppEnv) {
    const interval = boundedInteger(env.OFFICIAL_REQUEST_MIN_INTERVAL_MS, 150, 0, 5000);
    const readConcurrency = boundedInteger(env.OFFICIAL_READ_CONCURRENCY, 3, 1, 16);
    const writeConcurrency = boundedInteger(env.OFFICIAL_WRITE_CONCURRENCY, 1, 1, 8);
    const playwrightConcurrency = boundedInteger(env.PLAYWRIGHT_MAX_CONCURRENCY, 2, 1, 8);
    this.jobLimits = { READ: readConcurrency, WRITE: writeConcurrency, PLAYWRIGHT: playwrightConcurrency };
    this.officialReadLane = new AsyncLane(readConcurrency, interval);
    this.officialWriteLane = new AsyncLane(writeConcurrency, interval);
    this.playwrightLane = new AsyncLane(playwrightConcurrency, 0);
  }

  async initialize(): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE official_gateway_jobs
          SET status = 'QUEUED', locked_at = NULL, lease_until = NULL,
              available_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE status = 'RUNNING' AND lane = 'READ'`,
    ).bind(now, now).run();
    await this.env.DB.prepare(
      `UPDATE official_gateway_jobs
          SET status = 'FAILED', locked_at = NULL, lease_until = NULL,
              error_code = 'GATEWAY_RESTART_OUTCOME_UNKNOWN',
              error_message = '服务重启，写操作结果需要重新同步确认',
              finished_at = ?, updated_at = ?
        WHERE status = 'RUNNING' AND lane IN ('WRITE', 'PLAYWRIGHT')`,
    ).bind(now, now).run();
    const pollMs = boundedInteger(this.env.OFFICIAL_JOB_POLL_INTERVAL_MS, 250, 50, 5000);
    this.pollTimer = setInterval(() => this.pump(), pollMs);
    this.pollTimer.unref?.();
    this.pump();
  }

  registerHandler(kind: OfficialGatewayJobKind, handler: OfficialGatewayJobHandler): void {
    if (this.handlers.has(kind)) throw new Error(`Official gateway handler already registered: ${kind}`);
    this.handlers.set(kind, handler);
    this.pump();
  }

  async enqueue(input: EnqueueOfficialGatewayJob): Promise<OfficialGatewayJob> {
    if (input.dedupeKey) {
      const existing = await this.findActiveDedupe(input.dedupeKey);
      if (existing) return existing;
    }
    const now = Date.now();
    const id = crypto.randomUUID();
    const maxAttempts = input.maxAttempts ?? (input.lane === "READ" ? 3 : 1);
    try {
      await this.env.DB.prepare(
        `INSERT INTO official_gateway_jobs
          (id, kind, lane, owner_user_id, dedupe_key, payload_json, status, priority,
           attempt_count, max_attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, 0, ?, ?, ?, ?)`,
      ).bind(id, input.kind, input.lane, input.ownerUserId ?? null, input.dedupeKey ?? null,
        JSON.stringify(input.payload ?? {}), input.priority ?? 100, maxAttempts,
        input.availableAt ?? now, now, now).run();
    } catch (error) {
      if (input.dedupeKey) {
        const existing = await this.findActiveDedupe(input.dedupeKey);
        if (existing) return existing;
      }
      throw error;
    }
    this.pump();
    return (await this.getJob(id))!;
  }

  async getJob(jobId: string): Promise<OfficialGatewayJob | null> {
    const row = await this.env.DB.prepare(
      `SELECT id, kind, lane, owner_user_id, dedupe_key, payload_json, status, priority,
              attempt_count, max_attempts, available_at, result_json, error_code, error_message,
              created_at, started_at, finished_at, updated_at
         FROM official_gateway_jobs WHERE id = ?`,
    ).bind(jobId).first<JobRow>();
    return row ? jobFromRow(row) : null;
  }

  async waitForJob(jobId: string, timeoutMs: number): Promise<OfficialGatewayJob> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let job = await this.getJob(jobId);
    if (!job) throw new HttpError(404, "GATEWAY_JOB_NOT_FOUND", "访问任务不存在");
    while (job.status === "QUEUED" || job.status === "RUNNING") {
      if (Date.now() >= deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      job = await this.getJob(jobId);
      if (!job) throw new HttpError(404, "GATEWAY_JOB_NOT_FOUND", "访问任务不存在");
    }
    return job;
  }

  async readSnapshot<T>(key: string): Promise<OfficialGatewaySnapshot<T> | null> {
    const row = await this.env.DB.prepare(
      `SELECT cache_key, scope, owner_user_id, kind, value_json, version, fresh_until,
              stale_until, refreshed_at, refresh_job_id, last_error_code, last_error_message
         FROM official_gateway_snapshots WHERE cache_key = ?`,
    ).bind(key).first<SnapshotRow>();
    return row ? snapshotFromRow<T>(row) : null;
  }

  async writeSnapshot<T>(input: WriteOfficialGatewaySnapshot<T>): Promise<OfficialGatewaySnapshot<T>> {
    const now = Date.now();
    const freshUntil = now + Math.max(0, input.freshForMs);
    const staleUntil = freshUntil + Math.max(0, input.staleForMs);
    await this.env.DB.prepare(
      `INSERT INTO official_gateway_snapshots
        (cache_key, scope, owner_user_id, kind, value_json, version, fresh_until, stale_until,
         refreshed_at, refresh_job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         scope = excluded.scope, owner_user_id = excluded.owner_user_id, kind = excluded.kind,
         value_json = excluded.value_json, version = official_gateway_snapshots.version + 1,
         fresh_until = excluded.fresh_until, stale_until = excluded.stale_until,
         refreshed_at = excluded.refreshed_at, refresh_job_id = excluded.refresh_job_id,
         last_error_code = NULL, last_error_message = NULL, updated_at = excluded.updated_at`,
    ).bind(input.key, input.scope, input.ownerUserId ?? null, input.kind, JSON.stringify(input.value),
      freshUntil, staleUntil, now, input.refreshJobId ?? null, now, now).run();
    return (await this.readSnapshot<T>(input.key))!;
  }

  async markSnapshotError(key: string, jobId: string | null, code: string, message: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE official_gateway_snapshots
          SET refresh_job_id = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE cache_key = ?`,
    ).bind(jobId, code, message, Date.now(), key).run();
  }

  async linkSnapshotRefresh(key: string, jobId: string): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE official_gateway_snapshots SET refresh_job_id = ?, updated_at = ? WHERE cache_key = ?",
    ).bind(jobId, Date.now(), key).run();
  }

  runOfficialRequest<T>(key: string, mode: OfficialRequestMode, operation: () => Promise<T>): Promise<T> {
    if (mode === "WRITE") return this.officialWriteLane.run(operation);
    const existing = this.singleFlights.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = this.officialReadLane.run(operation).finally(() => {
      if (this.singleFlights.get(key) === promise) this.singleFlights.delete(key);
    });
    this.singleFlights.set(key, promise);
    return promise;
  }

  runPlaywright<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const flightKey = `playwright:${key}`;
    const existing = this.singleFlights.get(flightKey) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = this.playwrightLane.run(operation).finally(() => {
      if (this.singleFlights.get(flightKey) === promise) this.singleFlights.delete(flightKey);
    });
    this.singleFlights.set(flightKey, promise);
    return promise;
  }

  private async findActiveDedupe(dedupeKey: string): Promise<OfficialGatewayJob | null> {
    const row = await this.env.DB.prepare(
      `SELECT id, kind, lane, owner_user_id, dedupe_key, payload_json, status, priority,
              attempt_count, max_attempts, available_at, result_json, error_code, error_message,
              created_at, started_at, finished_at, updated_at
         FROM official_gateway_jobs
        WHERE dedupe_key = ? AND status IN ('QUEUED', 'RUNNING')
        ORDER BY created_at ASC LIMIT 1`,
    ).bind(dedupeKey).first<JobRow>();
    return row ? jobFromRow(row) : null;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pumpAsync().finally(() => { this.pumping = false; });
  }

  private async pumpAsync(): Promise<void> {
    for (const lane of ["WRITE", "READ", "PLAYWRIGHT"] as OfficialGatewayLane[]) {
      while (this.runningJobs[lane] < this.jobLimits[lane]) {
        const job = await this.claimNext(lane);
        if (!job) break;
        this.runningJobs[lane] += 1;
        void this.execute(job).finally(() => {
          this.runningJobs[lane] -= 1;
          this.pump();
        });
      }
    }
  }

  private async claimNext(lane: OfficialGatewayLane): Promise<OfficialGatewayJob | null> {
    const now = Date.now();
    const row = await this.env.DB.prepare(
      `SELECT id, kind, lane, owner_user_id, dedupe_key, payload_json, status, priority,
              attempt_count, max_attempts, available_at, result_json, error_code, error_message,
              created_at, started_at, finished_at, updated_at
         FROM official_gateway_jobs
        WHERE lane = ? AND status = 'QUEUED' AND available_at <= ?
        ORDER BY priority ASC, created_at ASC LIMIT 1`,
    ).bind(lane, now).first<JobRow>();
    if (!row || !this.handlers.has(row.kind)) return null;
    const claimed = await this.env.DB.prepare(
      `UPDATE official_gateway_jobs
          SET status = 'RUNNING', attempt_count = attempt_count + 1, locked_at = ?, lease_until = ?,
              started_at = COALESCE(started_at, ?), error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND status = 'QUEUED'`,
    ).bind(now, now + 10 * 60_000, now, now, row.id).run();
    return claimed.meta.changes === 1 ? this.getJob(row.id) : null;
  }

  private async execute(job: OfficialGatewayJob): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) return;
    try {
      const result = await handler(job);
      const now = Date.now();
      await this.env.DB.prepare(
        `UPDATE official_gateway_jobs
            SET status = 'SUCCEEDED', result_json = ?, error_code = NULL, error_message = NULL,
                lease_until = NULL, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'RUNNING'`,
      ).bind(JSON.stringify(result ?? null), now, now, job.id).run();
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "OFFICIAL_GATEWAY_JOB_FAILED";
      const message = error instanceof HttpError ? error.message : "官方访问任务执行失败";
      const latest = await this.getJob(job.id);
      const retry = latest !== null && latest.attemptCount < latest.maxAttempts;
      const now = Date.now();
      if (retry) {
        const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, latest.attemptCount - 1));
        await this.env.DB.prepare(
          `UPDATE official_gateway_jobs
              SET status = 'QUEUED', available_at = ?, locked_at = NULL, lease_until = NULL,
                  error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ? AND status = 'RUNNING'`,
        ).bind(now + delay, code, message, now, job.id).run();
      } else {
        await this.env.DB.prepare(
          `UPDATE official_gateway_jobs
              SET status = 'FAILED', locked_at = NULL, lease_until = NULL,
                  error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'RUNNING'`,
        ).bind(code, message, now, now, job.id).run();
      }
      console.error(JSON.stringify({ level: "error", event: "official_gateway_job_failed", jobId: job.id,
        kind: job.kind, attempt: latest?.attemptCount ?? job.attemptCount, retry, code }));
    }
  }
}
