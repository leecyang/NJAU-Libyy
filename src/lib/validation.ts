import { HttpError } from "./http";

export type Room = {
  id: number;
  name: string;
  roomLocation?: string;
  status?: number;
  remark?: string;
  minReservationNum: number;
  maxNum: number;
  startTime?: string;
  endTime?: string;
  reservationMinTime?: number;
  reservationMaxTime?: number;
  dateTimeSlicesList?: TimeSlice[][];
};

export type TimeSlice = {
  startTime: number;
  endTime: number;
  reservationStatus: number;
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
  if ((enforceHalfHour || room.dateTimeSlicesList) && (!isHalfHour(input.startTime) || !isHalfHour(input.endTime))) {
    throw new HttpError(400, "INVALID_TASK_TIME", "预约时间必须位于整点或半点");
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
  if (room.status !== undefined && room.status !== 0) {
    throw new HttpError(400, "ROOM_DISABLED", "该研讨室当前不可预约");
  }
  if (room.maxNum === 8 || room.maxNum === 12) {
    throw new HttpError(400, "ROOM_DISABLED", "该类型研讨室暂不开放预约");
  }
  if (input.memberCount + 1 < room.minReservationNum) {
    throw new HttpError(400, "MEMBERS_REQUIRED", `该房间至少需要 ${room.minReservationNum} 人`);
  }
  if (room.dateTimeSlicesList && !isRoomTimeAvailable(room, input.startTime, input.endTime)) {
    throw new HttpError(409, "ROOM_TIME_UNAVAILABLE", "所选时间段已不可预约");
  }
  return duration;
}

function localMinutes(timestamp: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function timeMinutes(value: string): number {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isRoomTimeAvailable(room: Room, startTime: string, endTime: string): boolean {
  if (!room.dateTimeSlicesList) return false;
  const start = timeMinutes(startTime);
  const end = timeMinutes(endTime);
  if (end <= start) return false;
  const available = new Set<number>();
  for (const slice of room.dateTimeSlicesList.flat()) {
    if (slice.reservationStatus === 0) available.add(localMinutes(slice.startTime));
  }
  for (let minute = start; minute < end; minute += 10) {
    if (!available.has(minute)) return false;
  }
  return true;
}

export function availableTimeRanges(room: Room): Array<{ startTime: string; endTime: string }> {
  if (!room.dateTimeSlicesList) return [];
  const available = room.dateTimeSlicesList.flat()
    .filter((slice) => slice.reservationStatus === 0)
    .map((slice) => ({ start: localMinutes(slice.startTime), end: localMinutes(slice.endTime) }))
    .sort((left, right) => left.start - right.start);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const slice of available) {
    const previous = ranges.at(-1);
    if (previous?.end === slice.start) previous.end = slice.end;
    else ranges.push({ ...slice });
  }
  const format = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return ranges.map((range) => ({ startTime: format(range.start), endTime: format(range.end) }));
}

export function assertThreeDayWindow(dateText: string, now = new Date()): void {
  if (!isIsoDate(dateText)) throw new HttpError(400, "INVALID_DATE", "日期格式错误");
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const selected = new Date(`${dateText}T00:00:00Z`);
  const days = Math.round((selected.valueOf() - today.valueOf()) / 86_400_000);
  if (days < 0 || days > 2) throw new HttpError(400, "OUTSIDE_RESERVATION_WINDOW", "仅可查询今天、明天和后天");
}
