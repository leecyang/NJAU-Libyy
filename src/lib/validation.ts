import { HttpError } from "./http";

export type Room = {
  id: number;
  name: string;
  roomLocation?: string;
  minReservationNum: number;
  maxNum: number;
  startTime?: string;
  endTime?: string;
  reservationMinTime?: number;
  reservationMaxTime?: number;
  dateTimeSlicesList?: unknown;
};

export type ReservationInput = {
  date: string;
  startTime: string;
  endTime: string;
  memberCount: number;
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertAllowedEmail(email: string, allowedDomains: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "INVALID_EMAIL", "邮箱格式错误");
  }
  const domain = email.split("@")[1];
  const allowed = allowedDomains.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!domain || !allowed.includes(domain)) {
    throw new HttpError(400, "EMAIL_DOMAIN_NOT_ALLOWED", "该邮箱域名暂不支持");
  }
}

export function assertPassword(password: string): void {
  if (password.length < 10 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, "WEAK_PASSWORD", "密码需为 10 至 128 位，并同时包含字母和数字");
  }
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

export function isHalfHour(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value);
}

export function minutesBetween(startTime: string, endTime: string): number {
  const parse = (time: string): number => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!match) throw new HttpError(400, "INVALID_TIME", "预约时间格式错误");
    return Number(match[1]) * 60 + Number(match[2]);
  };
  return parse(endTime) - parse(startTime);
}

export function assertReservation(room: Room, input: ReservationInput, enforceHalfHour: boolean): number {
  if (!isIsoDate(input.date)) throw new HttpError(400, "INVALID_DATE", "预约日期格式错误");
  if (enforceHalfHour && (!isHalfHour(input.startTime) || !isHalfHour(input.endTime))) {
    throw new HttpError(400, "INVALID_TASK_TIME", "自动预约时间必须位于整点或半点");
  }
  const duration = minutesBetween(input.startTime, input.endTime);
  if (duration <= 0 || duration > 120) {
    throw new HttpError(400, "INVALID_DURATION", "单次预约时长必须大于 0 且不超过 120 分钟");
  }
  if (room.reservationMaxTime && duration > room.reservationMaxTime) {
    throw new HttpError(400, "ROOM_DURATION_EXCEEDED", "预约时长超过该房间限制");
  }
  if (room.reservationMinTime && duration < room.reservationMinTime) {
    throw new HttpError(400, "ROOM_DURATION_TOO_SHORT", "预约时长低于该房间限制");
  }
  if (room.maxNum === 8 || room.maxNum === 12) {
    throw new HttpError(400, "ROOM_DISABLED", "该类型研讨室暂不开放预约");
  }
  if (input.memberCount + 1 < room.minReservationNum) {
    throw new HttpError(400, "MEMBERS_REQUIRED", `该房间至少需要 ${room.minReservationNum} 人`);
  }
  return duration;
}

export function assertThreeDayWindow(dateText: string, now = new Date()): void {
  if (!isIsoDate(dateText)) throw new HttpError(400, "INVALID_DATE", "日期格式错误");
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const selected = new Date(`${dateText}T00:00:00Z`);
  const days = Math.round((selected.valueOf() - today.valueOf()) / 86_400_000);
  if (days < 0 || days > 2) throw new HttpError(400, "OUTSIDE_RESERVATION_WINDOW", "仅可查询今天、明天和后天");
}

