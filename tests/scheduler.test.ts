import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config";
import {
  createOfficialQrSignCheckCode,
  fetchOfficialReservationHistory,
  signOutOfficialReservation,
  submitOfficialSign,
} from "../src/lib/official";
import { submitDueSignTasks, submitDueSignoutTasks, submitDueSignWorkflows } from "../src/lib/scheduler";

vi.mock("../src/lib/credentials", () => ({
  getAccessToken: vi.fn(async (_env: AppEnv, userId: string) => `token:${userId}`),
  getOfficialReservationProfile: vi.fn(async () => ({ studentId: "owner-student", realName: "Owner", mobile: "13000000000" })),
  refreshCredential: vi.fn(),
}));

vi.mock("../src/lib/mail", () => ({
  deliverDueMail: vi.fn(),
  queueMail: vi.fn(),
}));

vi.mock("../src/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("../src/lib/official", () => ({
  acceptOfficialReservation: vi.fn(),
  createOfficialQrSignCheckCode: vi.fn(),
  fetchOfficialReservationDates: vi.fn(),
  fetchOfficialReservationHistory: vi.fn(),
  fetchOfficialRoomDetail: vi.fn(),
  judgeOfficialReservationUsers: vi.fn(),
  signOutOfficialReservation: vi.fn(),
  submitOfficialSign: vi.fn(),
  submitOfficialReservation: vi.fn(),
  verifyOfficialRoomPolicy: vi.fn(),
}));

type SignRow = {
  id: string;
  reservation_id: string;
  official_reservation_id: string;
  status: string;
  owner_user_id: string;
  member_snapshot_json: string;
};

type SignoutRow = {
  id: string;
  reservation_id: string;
  official_reservation_id: string;
  status: string;
  owner_user_id: string;
};

class FakeStatement {
  private args: unknown[] = [];

  constructor(private readonly db: FakeDB, private readonly sql: string) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all<T>(this.sql) };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.db.run(this.sql, this.args);
  }
}

class FakeDB {
  readonly updates: Array<{ sql: string; args: unknown[] }> = [];

  constructor(
    private readonly signRows: SignRow[],
    private readonly signoutRows: SignoutRow[] = [],
    private readonly workflowRows: Array<Record<string, unknown>> = [],
    private readonly workflowParticipantRows: Array<Record<string, unknown>> = [],
  ) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  all<T>(sql: string): T[] {
    if (sql.includes("FROM sign_workflows")) return this.workflowRows as T[];
    if (sql.includes("FROM sign_workflow_participants")) return this.workflowParticipantRows as T[];
    if (sql.includes("FROM signout_tasks")) return this.signoutRows as T[];
    if (sql.includes("FROM sign_tasks")) return this.signRows as T[];
    return [];
  }

  run(sql: string, args: unknown[]): { meta: { changes: number } } {
    this.updates.push({ sql, args });
    return { meta: { changes: 1 } };
  }
}

function reservationRecord(status = 21) {
  return {
    id: 18660,
    roomId: 2,
    userId: "owner-student",
    reservationStatus: status,
    startTime: 1780376400000,
    endTime: 1780380000000,
    minSignTime: 1780375500000,
    maxSignTime: 1780377300000,
    roomName: "7E08",
  };
}

function env(db: FakeDB, vars: Partial<AppEnv> = {}): AppEnv {
  return {
    DB: db,
    ENABLE_AUTO_SIGN_SUBMISSION: "true",
    ENABLE_SIGNOUT_SUBMISSION: "true",
    SIGN_ROOM_SYSTEM_MAC_MAP: '{"2":"ZP2441000049"}',
    ...vars,
  } as unknown as AppEnv;
}

function dueSignRow(snapshot = "[]", status = "PENDING"): SignRow {
  return {
    id: "sign-task-id",
    reservation_id: "reservation-id",
    official_reservation_id: "18660",
    status,
    owner_user_id: "owner-user-id",
    member_snapshot_json: snapshot,
  };
}

function dueSignoutRow(status = "PENDING"): SignoutRow {
  return {
    id: "signout-task-id",
    reservation_id: "reservation-id",
    official_reservation_id: "18660",
    status,
    owner_user_id: "owner-user-id",
  };
}

beforeEach(() => {
  vi.mocked(fetchOfficialReservationHistory).mockReset();
  vi.mocked(createOfficialQrSignCheckCode).mockReset();
  vi.mocked(submitOfficialSign).mockReset();
  vi.mocked(signOutOfficialReservation).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("automatic sign scheduler", () => {
  it("signs with the owner first and stops after success", async () => {
    const db = new FakeDB([dueSignRow(JSON.stringify([{ localUserId: "member-user-id" }]))]);
    vi.mocked(fetchOfficialReservationHistory).mockResolvedValue([reservationRecord()]);
    vi.mocked(createOfficialQrSignCheckCode).mockResolvedValue("short-lived-key");
    vi.mocked(submitOfficialSign).mockResolvedValue();

    await submitDueSignTasks(env(db), 1780375500000);

    expect(createOfficialQrSignCheckCode).toHaveBeenCalledOnce();
    expect(createOfficialQrSignCheckCode).toHaveBeenCalledWith(expect.anything(), "token:owner-user-id", "2", "ZP2441000049");
    expect(submitOfficialSign).toHaveBeenCalledOnce();
    expect(db.updates.some((update) => update.sql.includes("UPDATE reservations SET status = ?") && update.args.includes("SIGNED_IN"))).toBe(true);
  });

  it("uses a local team member when the owner sign attempt fails", async () => {
    const db = new FakeDB([dueSignRow(JSON.stringify([{ localUserId: "member-user-id" }]))]);
    vi.mocked(fetchOfficialReservationHistory).mockResolvedValue([reservationRecord()]);
    vi.mocked(createOfficialQrSignCheckCode).mockResolvedValue("short-lived-key");
    vi.mocked(submitOfficialSign).mockRejectedValueOnce(new Error("owner failed")).mockResolvedValueOnce();

    await submitDueSignTasks(env(db), 1780375500000);

    expect(submitOfficialSign).toHaveBeenCalledTimes(2);
    expect(submitOfficialSign).toHaveBeenLastCalledWith(expect.anything(), "token:member-user-id", "2", "ZP2441000049", "short-lived-key");
    expect(db.updates.some((update) => update.sql.includes("UPDATE reservations SET status = ?") && update.args.includes("SIGNED_IN"))).toBe(true);
  });

  it("does not submit sign requests when the current room has no system mac mapping", async () => {
    const db = new FakeDB([dueSignRow()]);
    vi.mocked(fetchOfficialReservationHistory).mockResolvedValue([reservationRecord()]);

    await submitDueSignTasks(env(db, { SIGN_ROOM_SYSTEM_MAC_MAP: "{}" } as Partial<AppEnv>), 1780375500000);

    expect(createOfficialQrSignCheckCode).not.toHaveBeenCalled();
    expect(submitOfficialSign).not.toHaveBeenCalled();
    expect(db.updates.some((update) => update.args.includes("FAILED"))).toBe(true);
    expect(JSON.stringify(db.updates)).toContain("SIGN_DEVICE_NOT_CONFIGURED_FOR_ROOM");
  });

  it("handles already signed and cancelled official states idempotently", async () => {
    const signedDb = new FakeDB([dueSignRow()]);
    vi.mocked(fetchOfficialReservationHistory).mockResolvedValueOnce([reservationRecord(31)]);
    await submitDueSignTasks(env(signedDb), 1780375500000);
    expect(signedDb.updates.some((update) => update.sql.includes("UPDATE reservations SET status = ?") && update.args.includes("SIGNED_IN"))).toBe(true);

    const cancelledDb = new FakeDB([dueSignRow()]);
    vi.mocked(fetchOfficialReservationHistory).mockResolvedValueOnce([reservationRecord(61)]);
    await submitDueSignTasks(env(cancelledDb), 1780375500000);
    expect(cancelledDb.updates.some((update) => update.sql.includes("status = 'DISABLED'"))).toBe(true);
  });

  it("retries tasks left in submitting when the official state is still signable", async () => {
    const db = new FakeDB([dueSignRow("[]", "SUBMITTING")]);
    vi.mocked(fetchOfficialReservationHistory).mockResolvedValue([reservationRecord()]);
    vi.mocked(createOfficialQrSignCheckCode).mockResolvedValue("short-lived-key");
    vi.mocked(submitOfficialSign).mockResolvedValue();

    await submitDueSignTasks(env(db), 1780375500000);

    expect(submitOfficialSign).toHaveBeenCalledOnce();
    expect(db.updates.some((update) => update.sql.includes("status IN ('PENDING', 'SUBMITTING')"))).toBe(true);
  });
});

describe("automatic signout scheduler", () => {
  it("signs out scheduled reservations and marks success after official history confirms it", async () => {
    const db = new FakeDB([], [dueSignoutRow()]);
    vi.mocked(fetchOfficialReservationHistory)
      .mockResolvedValueOnce([reservationRecord(31)])
      .mockResolvedValueOnce([reservationRecord(51)]);
    vi.mocked(signOutOfficialReservation).mockResolvedValue();

    await submitDueSignoutTasks(env(db), 1780380000000);

    expect(signOutOfficialReservation).toHaveBeenCalledWith(expect.anything(), "token:owner-user-id", "owner-student", "2");
    expect(db.updates.some((update) => update.sql.includes("UPDATE signout_tasks SET status = 'SUCCESS'"))).toBe(true);
    expect(db.updates.some((update) => update.sql.includes("UPDATE reservations SET status = 'SIGNED_OUT'"))).toBe(true);
  });

  it("keeps signout retryable when official history has not yet reflected the transition", async () => {
    const db = new FakeDB([], [dueSignoutRow()]);
    vi.mocked(fetchOfficialReservationHistory)
      .mockResolvedValueOnce([reservationRecord(31)])
      .mockResolvedValueOnce([reservationRecord(31)]);
    vi.mocked(signOutOfficialReservation).mockResolvedValue();

    await submitDueSignoutTasks(env(db), 1780380000000);

    expect(db.updates.some((update) => update.sql.includes("status = 'PENDING'") && JSON.stringify(update.args).includes("signout_sync_pending"))).toBe(true);
  });

  it("disables signout tasks that are not in the signed-in official state", async () => {
    const db = new FakeDB([], [dueSignoutRow()]);
    vi.mocked(fetchOfficialReservationHistory).mockResolvedValue([reservationRecord(61)]);

    await submitDueSignoutTasks(env(db), 1780380000000);

    expect(signOutOfficialReservation).not.toHaveBeenCalled();
    expect(db.updates.some((update) => update.sql.includes("status = 'DISABLED'") && JSON.stringify(update.args).includes("record_not_signoutable"))).toBe(true);
  });

  it("retries signout tasks left in submitting when the official state is still signed in", async () => {
    const db = new FakeDB([], [dueSignoutRow("SUBMITTING")]);
    vi.mocked(fetchOfficialReservationHistory)
      .mockResolvedValueOnce([reservationRecord(31)])
      .mockResolvedValueOnce([reservationRecord(51)]);
    vi.mocked(signOutOfficialReservation).mockResolvedValue();

    await submitDueSignoutTasks(env(db), 1780380000000);

    expect(signOutOfficialReservation).toHaveBeenCalledOnce();
    expect(db.updates.some((update) => update.sql.includes("status IN ('PENDING', 'SUBMITTING')"))).toBe(true);
  });
});

describe("combined sign workflow scheduler", () => {
  it("generates a fresh room-specific key for every participant", async () => {
    const workflow = {
      id: "workflow-id",
      official_reservation_id: "18660",
      room_id: 2,
      date: "2026-06-02",
      start_time: "09:00",
      end_time: "10:00",
      sign_scheduled_at: 1780375500000,
      signout_scheduled_at: 1780380000000,
      signout_status: "PENDING",
    };
    const participants = [
      { user_id: "owner-user-id", participant_order: 1, sign_status: "PENDING" },
      { user_id: "member-user-id", participant_order: 2, sign_status: "PENDING" },
    ];
    const db = new FakeDB([], [], [workflow], participants);
    vi.mocked(fetchOfficialReservationHistory).mockResolvedValue([reservationRecord(21)]);
    vi.mocked(createOfficialQrSignCheckCode).mockResolvedValueOnce("key-owner").mockResolvedValueOnce("key-member");
    vi.mocked(submitOfficialSign).mockResolvedValue();

    await submitDueSignWorkflows(env(db), 1780375500000);

    expect(createOfficialQrSignCheckCode).toHaveBeenNthCalledWith(1, expect.anything(), "token:owner-user-id", "2", "ZP2441000049");
    expect(createOfficialQrSignCheckCode).toHaveBeenNthCalledWith(2, expect.anything(), "token:member-user-id", "2", "ZP2441000049");
    expect(submitOfficialSign).toHaveBeenNthCalledWith(1, expect.anything(), "token:owner-user-id", "2", "ZP2441000049", "key-owner");
    expect(submitOfficialSign).toHaveBeenNthCalledWith(2, expect.anything(), "token:member-user-id", "2", "ZP2441000049", "key-member");
  });
});
