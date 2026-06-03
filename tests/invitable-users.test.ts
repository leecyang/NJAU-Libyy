import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config";
import { createTask, invitableUsers } from "../src/api/app";

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
  constructor(private readonly db: FakeDB, private readonly sql: string) {}

  bind(): FakeStatement {
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
    return { meta: { changes: 1 } };
  }
}

class FakeDB {
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  all<T>(sql: string): T[] {
    if (sql.includes("FROM users")) {
      return [
        {
          id: "invitee-user-id",
          student_id: "9233020309",
          real_name: "Invitee User",
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

describe("invitable users API", () => {
  it("returns only the fields needed by team invitations", async () => {
    const response = await invitableUsers(env(), new Request("https://app.test/api/v1/users/invitable"));
    const body = await json(response);

    expect(body).toMatchObject({
      ok: true,
      data: [{
        id: "invitee-user-id",
        realName: "Invitee User",
        studentIdMasked: "92****09",
      }],
    });
    expect(JSON.stringify(body)).not.toContain("allowAutoJoinReservation");
  });
});

describe("automatic reservation members", () => {
  it("rejects recent contacts for automatic reservation tasks", async () => {
    await expect(createTask(env(), new Request("https://app.test/api/v1/reservation-tasks", {
      method: "POST",
      body: JSON.stringify({
        targetDate: "2026-06-04",
        startTime: "08:00",
        endTime: "09:00",
        candidateRooms: [{ roomId: 1, roomName: "7E01" }],
        contactIds: ["contact-id"],
      }),
    }))).rejects.toMatchObject({ code: "CONTACTS_NOT_ALLOWED" });
  });

  it("rejects removed auto-join members for automatic reservation tasks", async () => {
    await expect(createTask(env(), new Request("https://app.test/api/v1/reservation-tasks", {
      method: "POST",
      body: JSON.stringify({
        targetDate: "2026-06-04",
        startTime: "08:00",
        endTime: "09:00",
        candidateRooms: [{ roomId: 1, roomName: "7E01" }],
        autoJoinUserIds: ["user-id"],
      }),
    }))).rejects.toMatchObject({ code: "AUTO_JOIN_REMOVED" });
  });
});
