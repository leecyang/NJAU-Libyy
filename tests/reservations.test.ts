import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config";
import { assertCompleteSignDeviceMap, localReservationStatus, parseSignDeviceMap, reservationStatusLabel, resolveSignDevice } from "../src/lib/reservations";

vi.mock("../src/lib/credentials", () => ({
  getAccessToken: vi.fn(),
  getOfficialReservationProfile: vi.fn(),
}));

describe("reservation status labels", () => {
  it("maps official reservation statuses captured from browser traffic", () => {
    expect(localReservationStatus(12)).toBe("WAITING_MEMBER_CONFIRMATION");
    expect(localReservationStatus(21)).toBe("SCHEDULED");
    expect(localReservationStatus(31)).toBe("SIGNED_IN");
    expect(localReservationStatus(51)).toBe("SIGNED_OUT");
    expect(localReservationStatus(53)).toBe("SIGNED_OUT");
    expect(localReservationStatus(61)).toBe("CANCELLED");
    expect(localReservationStatus(63)).toBe("CANCELLED");

    expect(reservationStatusLabel("WAITING_MEMBER_CONFIRMATION", 12)).toBe("待成员确认");
    expect(reservationStatusLabel("SCHEDULED", 21)).toBe("待签到");
    expect(reservationStatusLabel("SIGNED_IN", 31)).toBe("已签到");
    expect(reservationStatusLabel("SIGNED_OUT", 51)).toBe("已签退");
    expect(reservationStatusLabel("SIGNED_OUT", 53)).toBe("系统签退");
    expect(reservationStatusLabel("CANCELLED", 61)).toBe("已取消");
    expect(reservationStatusLabel("CANCELLED", 63)).toBe("系统取消");
  });
});

describe("sign device mapping", () => {
  it("rejects duplicate system mac values across rooms", () => {
    expect(() => parseSignDeviceMap('{"2":"MAC-A","3":"MAC-A"}')).toThrowError(expect.objectContaining({ code: "SIGN_ROOM_SYSTEM_MAC_DUPLICATED" }));
  });

  it("never falls back to another room mapping", () => {
    expect(() => resolveSignDevice({ SIGN_ROOM_SYSTEM_MAC_MAP: '{"2":"MAC-A"}' } as AppEnv, 3))
      .toThrowError(expect.objectContaining({ code: "SIGN_DEVICE_NOT_CONFIGURED_FOR_ROOM" }));
  });

  it("requires the configured 2 through 27 room coverage at startup", () => {
    expect(() => assertCompleteSignDeviceMap('{"2":"MAC-A"}'))
      .toThrowError(expect.objectContaining({ code: "SIGN_ROOM_SYSTEM_MAC_MAP_INCOMPLETE" }));
  });
});
