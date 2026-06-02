import { describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import {
  assertAllowedEmail,
  assertPassword,
  assertReservation,
  assertThreeDayWindow,
  availableTimeRanges,
  isHalfHour,
  minutesBetween,
  type Room,
} from "../src/lib/validation";

const room: Room = {
  id: 6,
  name: "7E01",
  minReservationNum: 3,
  maxNum: 6,
  reservationMinTime: 30,
  reservationMaxTime: 120,
};

describe("account validation", () => {
  it("accepts configured email domains", () => {
    expect(() => assertAllowedEmail("student@qq.com", "qq.com,163.com")).not.toThrow();
  });

  it("rejects unconfigured email domains", () => {
    expect(() => assertAllowedEmail("student@example.com", "qq.com,163.com")).toThrow(HttpError);
  });

  it("requires a non-trivial password", () => {
    expect(() => assertPassword("longpassword1")).not.toThrow();
    expect(() => assertPassword("short1")).toThrow(HttpError);
  });
});

describe("reservation validation", () => {
  it("uses half-hour boundaries for automatic tasks", () => {
    expect(isHalfHour("17:30")).toBe(true);
    expect(isHalfHour("17:15")).toBe(false);
  });

  it("calculates reservation duration", () => {
    expect(minutesBetween("17:30", "19:00")).toBe(90);
  });

  it("counts the owner toward minReservationNum", () => {
    expect(assertReservation(room, { date: "2026-05-30", startTime: "17:00", endTime: "19:00", memberCount: 2 }, true)).toBe(120);
    expect(() => assertReservation(room, { date: "2026-05-30", startTime: "17:00", endTime: "19:00", memberCount: 1 }, true)).toThrow(HttpError);
  });

  it("blocks 8-person and 12-person rooms", () => {
    expect(() => assertReservation({ ...room, maxNum: 8 }, { date: "2026-05-30", startTime: "17:00", endTime: "18:00", memberCount: 2 }, true)).toThrow(HttpError);
    expect(() => assertReservation({ ...room, maxNum: 12 }, { date: "2026-05-30", startTime: "17:00", endTime: "18:00", memberCount: 2 }, true)).toThrow(HttpError);
  });

  it("limits browser room searches to three days", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    expect(() => assertThreeDayWindow("2026-06-01", now)).not.toThrow();
    expect(() => assertThreeDayWindow("2026-06-02", now)).toThrow(HttpError);
  });

  it("merges official ten-minute slices and rejects occupied time", () => {
    const detail = {
      ...room,
      status: 0,
      minReservationNum: 1,
      dateTimeSlicesList: [[
        { startTime: Date.parse("2026-06-02T00:00:00Z"), endTime: Date.parse("2026-06-02T00:10:00Z"), reservationStatus: 0 },
        { startTime: Date.parse("2026-06-02T00:10:00Z"), endTime: Date.parse("2026-06-02T00:20:00Z"), reservationStatus: 0 },
        { startTime: Date.parse("2026-06-02T00:20:00Z"), endTime: Date.parse("2026-06-02T00:30:00Z"), reservationStatus: 0 },
        { startTime: Date.parse("2026-06-02T00:30:00Z"), endTime: Date.parse("2026-06-02T00:40:00Z"), reservationStatus: 21 },
      ]],
    };
    expect(availableTimeRanges(detail)).toEqual([{ startTime: "08:00", endTime: "08:30" }]);
    expect(assertReservation(detail, { date: "2026-06-02", startTime: "08:00", endTime: "08:30", memberCount: 0 }, false)).toBe(30);
    expect(() => assertReservation(detail, { date: "2026-06-02", startTime: "08:00", endTime: "09:00", memberCount: 0 }, false)).toThrow(HttpError);
  });

  it("blocks rooms disabled by the official status", () => {
    expect(() => assertReservation({ ...room, status: 2 }, { date: "2026-06-02", startTime: "08:00", endTime: "08:30", memberCount: 2 }, true)).toThrow(HttpError);
  });
});
