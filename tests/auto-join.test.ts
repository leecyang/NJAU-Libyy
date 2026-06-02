import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config";
import { autoJoin, squareUsers } from "../src/api/app";

vi.mock("../src/lib/auth", () => ({
  currentUser: vi.fn(),
  requireAdmin: vi.fn(),
  requireUser: vi.fn(async () => ({
    id: "owner-user-id",
    email: "owner@example.com",
    role: "USER",
    status: "ACTIVE",
    student_id: "9233020709",
    real_name: "Owner",
    allow_auto_join_reservation: 0,
    square_visibility: "VISIBLE",
  })),
  revokeSession: vi.fn(),
}));

vi.mock("../src/lib/credentials", () => ({
  bindCredential: vi.fn(),
  credentialStatus: vi.fn(async () => ({ credential_status: "ACTIVE" })),
  getAccessToken: vi.fn(),
  getOfficialReservationProfile: vi.fn(),
}));

vi.mock("../src/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("../src/lib/mail", () => ({
  queueMail: vi.fn(),
}));

class FakeStatement {
  private args: unknown[] = [];

  constructor(private readonly db: FakeDB, private readonly sql: string) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    void this.sql;
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all<T>(this.sql) };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.db.updates.push({ sql: this.sql, args: this.args });
    return { meta: { changes: 1 } };
  }
}

class FakeDB {
  readonly updates: Array<{ sql: string; args: unknown[] }> = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  all<T>(sql: string): T[] {
    if (sql.includes("FROM users")) {
      return [
        {
          id: "auto-user-id",
          student_id: "9233020309",
          real_name: "Auto Join User",
          allow_auto_join_reservation: 1,
        },
      ] as T[];
    }
    return [];
  }
}

function env(db = new FakeDB()): AppEnv {
  return { DB: db } as unknown as AppEnv;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auto join profile API", () => {
  it("updates the user's auto-join authorization", async () => {
    const db = new FakeDB();
    const response = await autoJoin(env(db), new Request("https://app.test/api/v1/profile/auto-join", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    }));

    await expect(json(response)).resolves.toMatchObject({
      ok: true,
      data: { allowAutoJoinReservation: true },
    });
    expect(db.updates.some((update) => update.sql.includes("UPDATE users SET allow_auto_join_reservation = ?") && update.args[0] === 1)).toBe(true);
  });

  it("returns masked square users with auto-join visibility", async () => {
    const response = await squareUsers(env(), new Request("https://app.test/api/v1/square/users"));
    const body = await json(response);

    expect(body).toMatchObject({
      ok: true,
      data: [{
        id: "auto-user-id",
        realName: "Auto Join User",
        studentIdMasked: "92****09",
        allowAutoJoinReservation: true,
      }],
    });
  });
});
