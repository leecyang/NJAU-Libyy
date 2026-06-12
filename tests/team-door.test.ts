import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config";
import { canonicalReservationSource } from "../src/lib/user-metrics";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  credentialStatus: vi.fn(),
  getAccessToken: vi.fn(),
  syncOfficialReservationHistory: vi.fn(),
  officialMemberSnapshot: vi.fn(),
  resolveSignDevice: vi.fn(),
  createOfficialQrSignCheckCode: vi.fn(),
  submitOfficialSign: vi.fn(),
}));

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/auth")>(),
  requireUser: mocks.requireUser,
}));

vi.mock("../src/lib/credentials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/credentials")>(),
  credentialStatus: mocks.credentialStatus,
  getAccessToken: mocks.getAccessToken,
}));

vi.mock("../src/lib/reservations", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/reservations")>(),
  syncOfficialReservationHistory: mocks.syncOfficialReservationHistory,
  officialMemberSnapshot: mocks.officialMemberSnapshot,
  resolveSignDevice: mocks.resolveSignDevice,
}));

vi.mock("../src/lib/official", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/official")>(),
  createOfficialQrSignCheckCode: mocks.createOfficialQrSignCheckCode,
  submitOfficialSign: mocks.submitOfficialSign,
}));

import { openTeamDoor, teamDoorOptions } from "../src/api/team-door";

const LEADER_ID = "leader-id";
const MEMBER_ID = "member-id";
const TEAM_ID = "team-id";
const NOW = 1_781_246_100_000;

type TestMember = { id: string; studentId: string; realName: string };

class TeamDoorDB {
  auditEntries: unknown[][] = [];

  constructor(
    readonly leaderId = LEADER_ID,
    readonly members: TestMember[] = [
      { id: LEADER_ID, studentId: "9233000001", realName: "队长" },
      { id: MEMBER_ID, studentId: "9233000002", realName: "成员" },
    ],
  ) {}

  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first<T>() {
        if (sql.includes("SELECT id, name FROM teams")) {
          return (args[1] === db.leaderId ? { id: TEAM_ID, name: "测试小队" } : null) as T | null;
        }
        if (sql.includes("FROM users WHERE id = ?")) {
          const member = db.members.find((item) => item.id === args[0]);
          return (member ? {
            id: member.id,
            email: `${member.id}@example.com`,
            role: "USER",
            status: "ACTIVE",
            student_id: member.studentId,
            real_name: member.realName,
            allow_auto_join_reservation: 0,
            square_visibility: "PRIVATE",
          } : null) as T | null;
        }
        if (sql.includes("SELECT real_name, email FROM users")) {
          const member = db.members.find((item) => item.id === args[0]);
          return (member ? { real_name: member.realName, email: `${member.id}@example.com` } : null) as T | null;
        }
        return null as T | null;
      },
      async all<T>() {
        if (sql.includes("JOIN teams team ON team.id = ?")) {
          return {
            results: db.members.map((member) => ({
              id: member.id,
              student_id: member.studentId,
              real_name: member.realName,
            })),
          } as { results: T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes("INSERT INTO audit_logs")) db.auditEntries.push(args);
        return { meta: { changes: 1 } };
      },
    };
  }
}

function env(db = new TeamDoorDB()): AppEnv {
  return { DB: db } as unknown as AppEnv;
}

function record(id: number, userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    roomId: 22,
    roomName: "5E02",
    userId,
    userName: userId === "9233000001" ? "队长" : "成员",
    reservationStatus: 31,
    startTime: NOW - 10 * 60_000,
    endTime: NOW + 20 * 60_000,
    members: [],
    ...overrides,
  };
}

async function data<T>(response: Response): Promise<T> {
  const body = await response.json() as { data: T };
  return body.data;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mocks.requireUser.mockReset().mockResolvedValue({
    id: LEADER_ID,
    email: "leader@example.com",
    role: "USER",
    status: "ACTIVE",
    student_id: "9233000001",
    real_name: "队长",
  });
  mocks.credentialStatus.mockReset().mockResolvedValue({ credential_status: "ACTIVE", setup_required: false });
  mocks.getAccessToken.mockReset().mockImplementation(async (_env: AppEnv, userId: string) => `token:${userId}`);
  mocks.resolveSignDevice.mockReset().mockReturnValue({ roomId: "22", systemMac: "JWJA211231039" });
  mocks.createOfficialQrSignCheckCode.mockReset().mockResolvedValue("short-lived-key");
  mocks.submitOfficialSign.mockReset().mockResolvedValue(undefined);
  mocks.officialMemberSnapshot.mockReset().mockResolvedValue([
    { userId: "9233000001", realName: "队长", localUserId: LEADER_ID },
    { userId: "9233000002", realName: "成员", localUserId: MEMBER_ID },
  ]);
});

describe("team door", () => {
  it("allows only the current team leader to query door options", async () => {
    const database = new TeamDoorDB("another-leader");
    await expect(teamDoorOptions(env(database), new Request("http://localhost"), TEAM_ID))
      .rejects.toMatchObject({ code: "TEAM_LEADER_REQUIRED" });
  });

  it("aggregates matching signed-in reservations and filters invalid time or status", async () => {
    mocks.syncOfficialReservationHistory.mockImplementation(async (_env: AppEnv, user: { id: string }) => {
      if (user.id === LEADER_ID) {
        return [
          record(1001, "9233000001"),
          record(1002, "9233000001", { reservationStatus: 21 }),
          record(1003, "9233000001", { startTime: NOW + 1_000, endTime: NOW + 60_000 }),
        ];
      }
      return [record(2001, "9233000002")];
    });

    const result = await data<{ options: Array<{ id: string; signedInMembers: TestMember[] }>; warnings: unknown[] }>(
      await teamDoorOptions(env(), new Request("http://localhost"), TEAM_ID),
    );

    expect(result.options).toHaveLength(1);
    expect(result.options[0]?.signedInMembers.map((member) => member.id)).toEqual([LEADER_ID, MEMBER_ID]);
    expect(result.warnings).toEqual([]);
  });

  it("opens with another signed-in member when the first member request fails", async () => {
    mocks.syncOfficialReservationHistory.mockImplementation(async (_env: AppEnv, user: { id: string }) => [
      record(user.id === LEADER_ID ? 1001 : 2001, user.id === LEADER_ID ? "9233000001" : "9233000002"),
    ]);
    mocks.submitOfficialSign.mockRejectedValueOnce(new Error("first failed")).mockResolvedValueOnce(undefined);
    const optionId = canonicalReservationSource({
      roomId: 22,
      date: "2026-06-12",
      startTime: "14:25",
      endTime: "14:55",
      studentIds: ["9233000001", "9233000002"],
    });

    const result = await data<{ openedByUserId: string; openedByName: string }>(await openTeamDoor(
      env(),
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId }),
      }),
      TEAM_ID,
    ));

    expect(mocks.submitOfficialSign).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ openedByUserId: MEMBER_ID, openedByName: "成员" });
  });

  it("rejects an option that disappears before execution", async () => {
    mocks.syncOfficialReservationHistory.mockResolvedValue([]);
    await expect(openTeamDoor(
      env(),
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId: "expired" }),
      }),
      TEAM_ID,
    )).rejects.toMatchObject({ code: "TEAM_DOOR_OPTION_EXPIRED" });
    expect(mocks.submitOfficialSign).not.toHaveBeenCalled();
  });
});
