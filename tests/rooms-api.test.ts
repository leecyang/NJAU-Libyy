import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config";
import { rooms } from "../src/api/app";
import { fetchOfficialRoomDetail, fetchOfficialRooms } from "../src/lib/official";
import type { Room } from "../src/lib/validation";

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
    square_visibility: "VISIBLE",
  })),
  revokeSession: vi.fn(),
}));

vi.mock("../src/lib/credentials", () => ({
  bindCredential: vi.fn(),
  credentialStatus: vi.fn(async () => ({ credential_status: "ACTIVE" })),
  getAccessToken: vi.fn(async () => "access-token"),
  getOfficialReservationProfile: vi.fn(),
}));

vi.mock("../src/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("../src/lib/mail", () => ({
  queueMail: vi.fn(),
}));

vi.mock("../src/lib/official", () => ({
  acceptOfficialReservation: vi.fn(),
  cancelOfficialReservation: vi.fn(),
  createOfficialQrSignCheckCode: vi.fn(),
  fetchOfficialReservationDates: vi.fn(),
  fetchOfficialReservationHistory: vi.fn(),
  fetchOfficialRoomDetail: vi.fn(),
  fetchOfficialRooms: vi.fn(),
  judgeOfficialReservationUsers: vi.fn(),
  searchOfficialUsers: vi.fn(),
  signOutOfficialReservation: vi.fn(),
  submitOfficialReservation: vi.fn(),
  verifyOfficialRoomPolicy: vi.fn(),
}));

const baseRoom: Room = {
  id: 6,
  name: "7E01",
  status: 0,
  minReservationNum: 1,
  maxNum: 6,
  reservationMinTime: 30,
  reservationMaxTime: 120,
};

function env(): AppEnv {
  return {} as AppEnv;
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

function roomDetailFor(date: string, room: Room = baseRoom): Room {
  return {
    ...room,
    dateTimeSlicesList: [[
      { startTime: Date.parse(`${date}T00:00:00Z`), endTime: Date.parse(`${date}T00:10:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T00:10:00Z`), endTime: Date.parse(`${date}T00:20:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T00:20:00Z`), endTime: Date.parse(`${date}T00:30:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T00:30:00Z`), endTime: Date.parse(`${date}T00:40:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T00:40:00Z`), endTime: Date.parse(`${date}T00:50:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T00:50:00Z`), endTime: Date.parse(`${date}T01:00:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T01:00:00Z`), endTime: Date.parse(`${date}T01:10:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T01:10:00Z`), endTime: Date.parse(`${date}T01:20:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T01:20:00Z`), endTime: Date.parse(`${date}T01:30:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T01:30:00Z`), endTime: Date.parse(`${date}T01:40:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T01:40:00Z`), endTime: Date.parse(`${date}T01:50:00Z`), reservationStatus: 0 },
      { startTime: Date.parse(`${date}T01:50:00Z`), endTime: Date.parse(`${date}T02:00:00Z`), reservationStatus: 0 },
    ]],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-02T00:20:00Z"));
  vi.mocked(fetchOfficialRooms).mockResolvedValue([baseRoom]);
  vi.mocked(fetchOfficialRoomDetail).mockImplementation(async (_env, _token, _roomId, date) => roomDetailFor(date));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("rooms API availability windows", () => {
  it("returns three daily availability rows when date is omitted", async () => {
    const response = await rooms(env(), new Request("https://app.test/api/v1/rooms"));
    const body = await responseJson(response);

    expect(body.ok).toBe(true);
    expect(body.data.dates.map((item: { date: string }) => item.date)).toEqual(["2026-06-02", "2026-06-03", "2026-06-04"]);
    expect(body.data.rooms[0].dailyAvailability).toEqual([
      { date: "2026-06-02", label: "今天", availableRanges: [{ startTime: "08:30", endTime: "10:00" }] },
      { date: "2026-06-03", label: "明天", availableRanges: [{ startTime: "08:00", endTime: "10:00" }] },
      { date: "2026-06-04", label: "后天", availableRanges: [{ startTime: "08:00", endTime: "10:00" }] },
    ]);
    expect(fetchOfficialRooms).toHaveBeenCalledTimes(3);
    expect(fetchOfficialRoomDetail).toHaveBeenCalledTimes(3);
  });

  it("keeps official rooms that are not currently reservable in the list response", async () => {
    const unavailableRoom: Room = {
      ...baseRoom,
      id: 12,
      name: "7E12",
      maxNum: 8,
    };
    vi.mocked(fetchOfficialRooms).mockResolvedValue([baseRoom, unavailableRoom]);
    vi.mocked(fetchOfficialRoomDetail).mockImplementation(async (_env, _token, roomId, date) => {
      return roomDetailFor(date, roomId === unavailableRoom.id ? unavailableRoom : baseRoom);
    });

    const response = await rooms(env(), new Request("https://app.test/api/v1/rooms"));
    const body = await responseJson(response);

    expect(body.ok).toBe(true);
    expect(body.data.rooms).toHaveLength(2);
    expect(body.data.rooms.map((room: { name: string }) => room.name)).toEqual(["7E01", "7E12"]);
    expect(body.data.rooms.find((room: { id: number }) => room.id === unavailableRoom.id).reservable).toBe(false);
    expect(fetchOfficialRoomDetail).toHaveBeenCalledTimes(6);
  });

  it("keeps the single-date response shape for existing callers", async () => {
    const response = await rooms(env(), new Request("https://app.test/api/v1/rooms?date=2026-06-03"));
    const body = await responseJson(response);

    expect(body).toMatchObject({
      ok: true,
      data: {
        date: "2026-06-03",
        rooms: [{
          id: 6,
          availableRanges: [{ startTime: "08:00", endTime: "10:00" }],
        }],
      },
    });
    expect(body.data.rooms[0].dailyAvailability).toBeUndefined();
    expect(fetchOfficialRooms).toHaveBeenCalledOnce();
    expect(fetchOfficialRoomDetail).toHaveBeenCalledOnce();
  });
});
