import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config";
import { applyMigrations } from "../src/node/migrations";
import { openSqliteDatabase } from "../src/node/sqlite";
import { claimReservationQuota, releaseReservationQuota, reservationQuotas } from "../src/lib/user-metrics";

function testEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "njau-libyy-metrics-"));
  const db = openSqliteDatabase(path.join(dir, "test.sqlite"));
  applyMigrations(db, path.resolve("migrations"));
  return { DB: db } as unknown as AppEnv;
}

async function addUser(env: AppEnv, id: string) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, email_verified_at, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, `${id}@example.com`, now, "hash", now, now).run();
}

describe("reservation quota claims", () => {
  it("allows two claims, rejects the third, and restores capacity after release", async () => {
    const env = testEnv();
    await addUser(env, "user-a");

    await claimReservationQuota(env, ["user-a"], "2026-06-12", "TASK", "task-1");
    await claimReservationQuota(env, ["user-a"], "2026-06-12", "TASK", "task-2");
    await expect(claimReservationQuota(env, ["user-a"], "2026-06-12", "TASK", "task-3"))
      .rejects.toMatchObject({ code: "DAILY_RESERVATION_LIMIT" });

    let quota = (await reservationQuotas(env.DB, ["user-a"], ["2026-06-12"])).get("user-a")![0]!;
    expect(quota).toMatchObject({ used: 2, remaining: 0, limit: 2 });

    await releaseReservationQuota(env, "TASK", "task-1");
    await claimReservationQuota(env, ["user-a"], "2026-06-12", "TASK", "task-3");
    quota = (await reservationQuotas(env.DB, ["user-a"], ["2026-06-12"])).get("user-a")![0]!;
    expect(quota).toMatchObject({ used: 2, remaining: 0 });
  });

  it("rolls back every member when one participant has no remaining slot", async () => {
    const env = testEnv();
    await addUser(env, "user-a");
    await addUser(env, "user-b");
    await claimReservationQuota(env, ["user-a"], "2026-06-12", "TASK", "existing-1");
    await claimReservationQuota(env, ["user-a"], "2026-06-12", "TASK", "existing-2");

    await expect(claimReservationQuota(env, ["user-a", "user-b"], "2026-06-12", "TASK", "group-task"))
      .rejects.toMatchObject({ code: "DAILY_RESERVATION_LIMIT" });

    const quotas = await reservationQuotas(env.DB, ["user-a", "user-b"], ["2026-06-12"]);
    expect(quotas.get("user-a")![0]).toMatchObject({ used: 2, remaining: 0 });
    expect(quotas.get("user-b")![0]).toMatchObject({ used: 0, remaining: 2 });
  });
});
