import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config";
import { applyMigrations } from "../src/node/migrations";
import { NodeOfficialAccessGateway } from "../src/node/official-access-gateway";
import { openSqliteDatabase } from "../src/node/sqlite";

function testEnv(): AppEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "njau-gateway-"));
  const db = openSqliteDatabase(path.join(dir, "test.sqlite"));
  applyMigrations(db, path.resolve("migrations"));
  return {
    DB: db,
    OFFICIAL_READ_CONCURRENCY: "2",
    OFFICIAL_WRITE_CONCURRENCY: "1",
    OFFICIAL_REQUEST_MIN_INTERVAL_MS: "0",
    OFFICIAL_JOB_POLL_INTERVAL_MS: "50",
    PLAYWRIGHT_MAX_CONCURRENCY: "1",
  } as unknown as AppEnv;
}

describe("Official Access Gateway", () => {
  it("deduplicates active persistent jobs and stores their result", async () => {
    const env = testEnv();
    const gateway = new NodeOfficialAccessGateway(env);
    env.OFFICIAL_GATEWAY = gateway;
    gateway.registerHandler("ROOMS_REFRESH", async (job) => ({ handled: job.id }));
    await gateway.initialize();

    const first = await gateway.enqueue({
      kind: "ROOMS_REFRESH",
      lane: "READ",
      dedupeKey: "rooms:today",
      payload: {},
    });
    const second = await gateway.enqueue({
      kind: "ROOMS_REFRESH",
      lane: "READ",
      dedupeKey: "rooms:today",
      payload: {},
    });

    expect(second.id).toBe(first.id);
    const completed = await gateway.waitForJob(first.id, 2000);
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.result).toEqual({ handled: first.id });
  });

  it("persists SWR snapshot metadata and classifies freshness", async () => {
    const env = testEnv();
    const gateway = new NodeOfficialAccessGateway(env);
    await gateway.initialize();
    const snapshot = await gateway.writeSnapshot({
      key: "global:rooms:2026-06-10",
      scope: "GLOBAL",
      kind: "ROOMS",
      value: { rooms: [1, 2] },
      freshForMs: 60_000,
      staleForMs: 120_000,
      refreshJobId: "job-1",
    });

    expect(snapshot.freshness).toBe("FRESH");
    expect(snapshot.value).toEqual({ rooms: [1, 2] });
    expect(snapshot.refreshJobId).toBe("job-1");
  });

  it("single-flights reads and serializes write operations", async () => {
    const env = testEnv();
    const gateway = new NodeOfficialAccessGateway(env);
    let readCalls = 0;
    const read = () => gateway.runOfficialRequest("same-read", "READ", async () => {
      readCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return readCalls;
    });
    const [left, right] = await Promise.all([read(), read()]);
    expect(left).toBe(1);
    expect(right).toBe(1);
    expect(readCalls).toBe(1);

    let active = 0;
    let maxActive = 0;
    const write = (value: number) => gateway.runOfficialRequest(`write-${value}`, "WRITE", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value;
    });
    await Promise.all([write(1), write(2), write(3)]);
    expect(maxActive).toBe(1);
  });

  it("requeues interrupted reads but does not replay interrupted writes", async () => {
    const env = testEnv();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO official_gateway_jobs
        (id, kind, lane, payload_json, status, priority, attempt_count, max_attempts,
         available_at, locked_at, lease_until, created_at, started_at, updated_at)
       VALUES (?, 'ROOMS_REFRESH', 'READ', '{}', 'RUNNING', 100, 1, 3, ?, ?, ?, ?, ?, ?)`,
    ).bind("read-job", now, now, now + 60_000, now, now, now).run();
    await env.DB.prepare(
      `INSERT INTO official_gateway_jobs
        (id, kind, lane, payload_json, status, priority, attempt_count, max_attempts,
         available_at, locked_at, lease_until, created_at, started_at, updated_at)
       VALUES (?, 'MANUAL_RESERVATION', 'WRITE', '{}', 'RUNNING', 100, 1, 1, ?, ?, ?, ?, ?, ?)`,
    ).bind("write-job", now, now, now + 60_000, now, now, now).run();

    const gateway = new NodeOfficialAccessGateway(env);
    await gateway.initialize();
    expect((await gateway.getJob("read-job"))?.status).toBe("QUEUED");
    expect(await gateway.getJob("write-job")).toMatchObject({
      status: "FAILED",
      errorCode: "GATEWAY_RESTART_OUTCOME_UNKNOWN",
    });
  });
});
