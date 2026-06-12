import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import {
  Activity,
  ArrowRight,
  CalendarClock,
  ChevronLeft,
  CircleUserRound,
  ClipboardList,
  Database,
  DoorOpen,
  History,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  RefreshCw,
  Send,
  Settings,
  Shield,
  UsersRound,
} from "lucide-react";
import { api, ApiError, type GatewayJob, waitForGatewayJob } from "./api";

gsap.registerPlugin(useGSAP, ScrollTrigger);

type Page = "rooms" | "tasks" | "teams" | "history" | "admin";
type Route = {
  page: Page;
  roomId?: number;
  taskMode?: "list" | "new";
  teamMode?: "list" | "new";
  teamInviteId?: string;
  adminCollection?: string;
};
type Session = {
  user: {
    id: string;
    email: string;
    role: "USER" | "ADMIN";
    studentId: string | null;
    realName: string | null;
    totalScore: number | null;
  };
  credential: {
    credential_status: string;
    setup_required?: boolean;
    login_student_id?: string | null;
    login_attempt?: {
      attemptId: string;
      purpose: "INITIAL_BIND" | "REBIND" | "AUTO_RECOVERY";
      status: "QUEUED" | "RUNNING" | "SMS_REQUIRED" | "SUCCEEDED" | "FAILED" | "EXPIRED";
      progress: string;
      smsExpiresAt: number | null;
      errorCode: string | null;
      errorMessage: string | null;
    } | null;
  };
};
type AvailabilityRange = { startTime: string; endTime: string };
type DailyAvailability = {
  date: string;
  label?: string;
  availableRanges: AvailabilityRange[];
};
type Room = {
  id: number;
  name: string;
  roomLocation?: string;
  status?: number;
  reservable?: boolean;
  maxNum: number;
  minReservationNum: number;
  availableRanges?: AvailabilityRange[];
  dailyAvailability?: DailyAvailability[];
};
type RoomWithDays = Room & {
  days: Record<string, AvailabilityRange[]>;
};
type RoomsResponse = {
  date?: string;
  dates?: Array<{ date: string; label?: string }>;
  rooms: Room[];
  cache?: {
    status: "FRESH" | "STALE" | "EXPIRED" | "MISS";
    version: number;
    refreshedAt: number | null;
    refreshJobId: string | null;
    error: { code: string; message: string | null } | null;
  };
};
type TimeSelection = {
  date: string;
  startIndex: number;
  endIndex: number;
  startTime: string;
  endTime: string;
};
type Reservation = Record<string, string | number | boolean | null>;
type Task = Record<string, string | number | null>;
type ReservationParticipant = {
  id: string;
  studentId: string;
  realName: string;
  email: string;
  isCurrentUser: boolean;
  teamName: string | null;
  totalScore: number | null;
  scoreRefreshedAt: number | null;
  reservationQuota: Array<{ date: string; used: number; remaining: number; limit: number }>;
};
type ReservationOption = {
  id: string;
  ownerUserId: string;
  ownerName: string;
  officialReservationId: string;
  roomId: number;
  roomName: string;
  date: string;
  startTime: string;
  endTime: string;
  participants: Array<{
    userId: string;
    studentId: string;
    realName: string;
    participantOrder: number;
    isPrimary: boolean;
  }>;
};
type SignWorkflowParticipant = {
  userId: string;
  realName: string;
  participantOrder: number;
  signStatus: string;
  signAttemptCount: number;
  signedAt: number | null;
  lastErrorCode?: string | null;
};
type SignWorkflow = {
  id: string;
  room_name_snapshot: string;
  date: string;
  start_time: string;
  end_time: string;
  sign_scheduled_at: number;
  signout_scheduled_at: number;
  status: string;
  signout_status: string;
  signout_executed_at?: number | null;
  failure_code?: string | null;
  participants: SignWorkflowParticipant[];
};
type TeamMember = {
  id: string;
  email?: string;
  realName?: string;
  real_name?: string;
  studentId?: string;
  student_id?: string;
  teamName?: string;
};
type Team = {
  id: string;
  name: string;
  description?: string;
  leader_user_id?: string;
  leader_name?: string;
  is_leader?: boolean | number;
  members?: TeamMember[] | string | null;
};
type TeamInvitation = {
  id: string;
  team_id: string;
  status: string;
  expires_at: number;
  created_at: number;
  team_name: string;
  inviter_name?: string;
};
type InvitableUser = {
  id: string;
  email: string;
  real_name?: string;
  student_id?: string;
};

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00+08:00`);
  value.setDate(value.getDate() + days);
  return value.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function threeDayDates(): string[] {
  const start = today();
  return [start, addDays(start, 1), addDays(start, 2)];
}

function dayLabel(date: string): string {
  const value = new Date(`${date}T00:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "Asia/Shanghai" }).format(value);
  return `${date.slice(5)} ${weekday}`;
}

function formatTimestamp(value: number | string | null | undefined): string {
  const timestamp = typeof value === "string" ? Number(value) : value;
  if (!timestamp || !Number.isFinite(timestamp)) return "待定";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(timestamp));
}

function statusText(status: string | number | null | undefined): string {
  const value = String(status ?? "UNKNOWN");
  const labels: Record<string, string> = {
    DRAFT: "尚未开始",
    WAITING_WINDOW: "等待开放",
    WAITING_MEMBERS: "等待成员确认",
    READY: "已准备",
    ACTIVE: "正在进行",
    SUBMITTING: "正在提交",
    SUCCESS: "已完成",
    FAILED: "未完成",
    CANCELLED: "已取消",
    EXPIRED: "已过期",
    PENDING: "等待进行",
    DISABLED: "已关闭",
  };
  return labels[value] ?? "状态待确认";
}

function credentialStatusText(status: string): string {
  const labels: Record<string, string> = {
    ACTIVE: "已连接",
    REFRESHING: "正在连接",
    REFRESH_FAILED: "连接未完成",
    REAUTH_REQUIRED: "需要重新连接",
    DISABLED: "暂不可用",
  };
  return labels[status] ?? "等待连接";
}

function taskCandidateText(task: Task): string {
  const raw = task.candidate_rooms;
  if (typeof raw !== "string") return "候选房间待定";
  try {
    const rooms = JSON.parse(raw) as unknown;
    if (!Array.isArray(rooms)) return "候选房间待定";
    const names = rooms
      .filter(isRecord)
      .map((room) => String(room.roomName ?? room.room_id ?? room.roomId ?? ""))
      .filter(Boolean);
    return names.length ? names.join("、") : "候选房间待定";
  } catch {
    return raw || "候选房间待定";
  }
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function minutesToTime(value: number): string {
  const hour = Math.floor(value / 60).toString().padStart(2, "0");
  const minute = (value % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

function formData(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTeamMembers(value: Team["members"]): TeamMember[] {
  if (!value) return [];
  const raw = typeof value === "string"
    ? (() => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return [];
      }
    })()
    : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((member) => ({
    id: String(member.id ?? ""),
    email: typeof member.email === "string" ? member.email : undefined,
    realName: typeof member.realName === "string" ? member.realName : undefined,
    real_name: typeof member.real_name === "string" ? member.real_name : undefined,
    studentId: typeof member.studentId === "string" ? member.studentId : undefined,
    student_id: typeof member.student_id === "string" ? member.student_id : undefined,
  })).filter((member) => member.id);
}

function memberName(member: TeamMember): string {
  return member.realName ?? member.real_name ?? member.email ?? member.id;
}

function isTeamLeader(team: Team): boolean {
  return team.is_leader === true || team.is_leader === 1;
}

function visibleTeamMembers(team: Team): Array<{ id: string; name: string; role: string }> {
  const members = parseTeamMembers(team.members).map((member) => ({
    id: member.id,
    name: memberName(member),
    role: "队友",
  }));
  return [
    { id: team.leader_user_id ?? `${team.id}-leader`, name: team.leader_name ?? "队长", role: "队长" },
    ...members,
  ];
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function Toast({ message, error }: { message: string; error?: boolean }) {
  if (!message) return null;
  return <div className={error ? "toast error" : "toast"}>{message}</div>;
}

function Button({
  children,
  variant = "primary",
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost"; busy?: boolean }) {
  return (
    <button {...props} className={`button ${variant} ${props.className ?? ""}`} disabled={props.disabled || busy}>
      {busy ? <Loader2 size={16} className="spin" /> : null}
      {children}
    </button>
  );
}

function Card({ children, title, icon }: { children: ReactNode; title?: string; icon?: ReactNode }) {
  return (
    <section className="card motion-card">
      {title ? <div className="card-title">{icon}<h2>{title}</h2></div> : null}
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "brand-lockup compact" : "brand-lockup"}>
      <span className="brand-symbol" aria-hidden="true" />
      <span><strong>NJAU Libyy</strong>{compact ? null : <small>研讨间预约</small>}</span>
    </span>
  );
}

function PageIntro({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-intro motion-reveal">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-intro-action">{action}</div> : null}
    </header>
  );
}

function PageStage({ page, children }: { page: Page; children: ReactNode }) {
  const scope = useRef<HTMLElement>(null);

  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.fromTo(
      ".motion-reveal",
      { autoAlpha: 0, y: 18 },
      { autoAlpha: 1, y: 0, duration: 0.7, stagger: 0.08, ease: "power3.out" },
    );
    gsap.utils.toArray<HTMLElement>(".motion-card").forEach((card, index) => {
      gsap.fromTo(card, {
        autoAlpha: 0.72,
        scale: 0.985,
        y: Math.min(index * 6, 18),
      }, {
        autoAlpha: 1,
        scale: 1,
        y: 0,
        ease: "none",
        scrollTrigger: {
          trigger: card,
          start: "top 96%",
          end: "top 68%",
          scrub: 0.6,
        },
      });
    });
  }, { scope, dependencies: [page], revertOnUpdate: true });

  return <main className="content" ref={scope}>{children}</main>;
}

const pagePaths: Record<Page, string> = {
  rooms: "/rooms",
  tasks: "/tasks",
  teams: "/teams",
  history: "/history",
  admin: "/admin",
};

function pagePath(page: Page): string {
  return pagePaths[page];
}

function routeFromPath(pathname: string): Route {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const roomMatch = normalized.match(/^\/rooms\/(\d+)$/);
  const adminMatch = normalized.match(/^\/admin\/([a-z-]+)$/);
  const teamInviteMatch = normalized.match(/^\/teams\/([^/]+)\/invite$/);
  if (roomMatch) return { page: "rooms", roomId: Number(roomMatch[1]) };
  if (normalized === "/tasks/new") return { page: "tasks", taskMode: "new" };
  if (normalized === "/tasks") return { page: "tasks" };
  if (teamInviteMatch?.[1]) return { page: "teams", teamInviteId: decodeURIComponent(teamInviteMatch[1]) };
  if (normalized === "/teams/new") return { page: "teams", teamMode: "new" };
  if (normalized === "/teams") return { page: "teams" };
  if (normalized === "/history") return { page: "history" };
  if (adminMatch) return { page: "admin", adminCollection: adminMatch[1] };
  if (normalized === "/admin") return { page: "admin" };
  return { page: "rooms" };
}

function normalizeRooms(response: RoomsResponse, fallbackDates: string[]): { dates: string[]; rooms: RoomWithDays[] } {
  const dates = response.dates?.map((item) => item.date) ?? (response.date ? [response.date] : fallbackDates);
  const rooms = response.rooms.map((room) => {
    const days: Record<string, AvailabilityRange[]> = {};
    if (room.dailyAvailability?.length) {
      for (const day of room.dailyAvailability) {
        days[day.date] = day.availableRanges ?? [];
      }
    } else if (response.date) {
      days[response.date] = room.availableRanges ?? [];
    } else {
      for (const date of dates) days[date] = room.availableRanges ?? [];
    }
    return { ...room, days };
  });
  return { dates, rooms: rooms.sort((left, right) => left.name.localeCompare(right.name, "zh-CN")) };
}

function rangeText(ranges: AvailabilityRange[]): string {
  if (!ranges.length) return "暂无可用时段";
  return ranges.slice(0, 4).map((range) => `${range.startTime}-${range.endTime}`).join("、");
}

const timeSlots = Array.from({ length: 28 }, (_, index) => minutesToTime(8 * 60 + index * 30));
const availabilityTicks = Array.from({ length: 8 }, (_, index) => 8 + index * 2);
type TrackerBlock = {
  key: string;
  state: "available" | "empty" | "selected" | "expired";
  tooltip: string;
  ariaLabel?: string;
  disabled?: boolean;
};

function slotExpired(date: string, slot: string, now = Date.now()): boolean {
  const end = minutesToTime(timeToMinutes(slot) + 30);
  return new Date(`${date}T${end}:00+08:00`).valueOf() <= now;
}

function slotAvailable(ranges: AvailabilityRange[], slot: string): boolean {
  const start = timeToMinutes(slot);
  const end = start + 30;
  return ranges.some((range) => start >= timeToMinutes(range.startTime) && end <= timeToMinutes(range.endTime));
}

function UptimeKumaTicks() {
  return (
    <div className="uptime-kuma-ticks" aria-hidden="true">
      {availabilityTicks.map((hour) => <span key={hour}>{String(hour).padStart(2, "0")}</span>)}
    </div>
  );
}

function UptimeKumaTimeline({
  data,
  label,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  data: TrackerBlock[];
  label: string;
  onSelect?: (index: number) => void;
  onDragStart?: (index: number) => void;
  onDragMove?: (index: number) => void;
  onDragEnd?: () => void;
}) {
  const segments = Array.from({ length: Math.ceil(data.length / 4) }, (_, index) => data.slice(index * 4, index * 4 + 4));
  const pointerActive = useRef(false);
  const suppressClick = useRef(false);

  function pointerIndex(clientX: number, clientY: number): number | null {
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-time-index]");
    const index = Number(element?.dataset.timeIndex);
    return Number.isInteger(index) ? index : null;
  }

  return (
    <div
      className={`uptime-kuma-timeline${onDragStart ? " draggable" : ""}`}
      role={onSelect ? "group" : "img"}
      aria-label={label}
      onPointerDown={onDragStart ? (event) => {
        const index = pointerIndex(event.clientX, event.clientY);
        if (index === null || data[index]?.disabled) return;
        pointerActive.current = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onDragStart(index);
      } : undefined}
      onPointerMove={onDragMove ? (event) => {
        if (!pointerActive.current) return;
        const index = pointerIndex(event.clientX, event.clientY);
        if (index !== null && !data[index]?.disabled) onDragMove(index);
      } : undefined}
      onPointerUp={onDragEnd ? (event) => {
        if (!pointerActive.current) return;
        pointerActive.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onDragEnd();
      } : undefined}
      onPointerCancel={onDragEnd ? () => {
        if (!pointerActive.current) return;
        pointerActive.current = false;
        onDragEnd();
      } : undefined}
    >
      {segments.map((segment, segmentIndex) => (
        <span className="uptime-kuma-segment" key={`segment-${segmentIndex}`}>
          {segment.map((block, blockIndex) => {
            const index = segmentIndex * 4 + blockIndex;
            return onSelect ? (
              <button
                type="button"
                className={`uptime-kuma-heartbeat ${block.state}`}
                key={block.key}
                title={block.tooltip}
                disabled={block.disabled}
                aria-label={block.ariaLabel ?? block.tooltip}
                aria-pressed={block.state === "selected"}
                data-time-index={index}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onSelect(index);
                }}
              />
            ) : (
              <span
                className={`uptime-kuma-heartbeat ${block.state}`}
                key={block.key}
                title={block.tooltip}
              />
            );
          })}
        </span>
      ))}
    </div>
  );
}

function RoomAvailabilityHistory({ dates, room }: { dates: string[]; room: RoomWithDays }) {
  return (
    <div className="availability-history" aria-label={`${room.name} 三天可用时间状态`}>
      <UptimeKumaTicks />
      <div className="availability-rows">
        {dates.map((date) => {
          const ranges = room.days[date] ?? [];
          return (
            <div className="availability-row" key={`${room.id}-${date}`}>
              <span className="availability-day">{dayLabel(date)}</span>
              <UptimeKumaTimeline
                label={`${room.name} ${dayLabel(date)} 08:00 到 22:00 可用状态`}
                data={timeSlots.map((slot) => {
                  const end = minutesToTime(timeToMinutes(slot) + 30);
                  const expired = slotExpired(date, slot);
                  const state = expired ? "expired" : slotAvailable(ranges, slot) ? "available" : "empty";
                  return {
                    key: `${date}-${slot}`,
                    state,
                    tooltip: `${dayLabel(date)} ${slot}-${end} ${state === "expired" ? "已过期" : state === "available" ? "可用" : "不可用"}`,
                  };
                })}
              />
            </div>
          );
        })}
      </div>
      <div className="availability-legend" aria-hidden="true">
        <span><i className="available" />可用</span>
        <span><i className="occupied" />不可用</span>
        <span><i className="expired" />已过期</span>
      </div>
    </div>
  );
}

function selectionContains(selection: TimeSelection | null, date: string, index: number): boolean {
  return Boolean(selection && selection.date === date && index >= selection.startIndex && index <= selection.endIndex);
}

function SquareTimeGridPicker({
  dates,
  room,
  selection,
  onChange,
}: {
  dates: string[];
  room: RoomWithDays;
  selection: TimeSelection | null;
  onChange: (selection: TimeSelection | null) => void;
}) {
  const drag = useRef<{ date: string; anchor: number } | null>(null);

  function selectRange(date: string, anchor: number, index: number) {
    const ranges = room.days[date] ?? [];
    const startIndex = Math.min(anchor, index);
    const endIndex = Math.max(anchor, index);
    const selectedSlots = timeSlots.slice(startIndex, endIndex + 1);
    const valid = selectedSlots.length <= 4 && selectedSlots.every((slot) => slotAvailable(ranges, slot) && !slotExpired(date, slot));
    if (!valid) return;
    onChange({
      date,
      startIndex,
      endIndex,
      startTime: timeSlots[startIndex] ?? "08:00",
      endTime: minutesToTime(timeToMinutes(timeSlots[endIndex] ?? "08:00") + 30),
    });
  }

  function choose(date: string, index: number) {
    const ranges = room.days[date] ?? [];
    if (room.reservable === false || slotExpired(date, timeSlots[index] ?? "") || !slotAvailable(ranges, timeSlots[index] ?? "")) return;

    if (selectionContains(selection, date, index)) {
      onChange(null);
      return;
    }

    let startIndex = index;
    let endIndex = index;
    if (selection?.date === date) {
      startIndex = Math.min(selection.startIndex, index);
      endIndex = Math.max(selection.endIndex, index);
      const selectedSlots = timeSlots.slice(startIndex, endIndex + 1);
      const valid = selectedSlots.length <= 4 && selectedSlots.every((slot) => slotAvailable(ranges, slot));
      if (!valid) {
        startIndex = index;
        endIndex = index;
      }
    }

    selectRange(date, startIndex, endIndex);
  }

  return (
    <div className="square-time-picker">
      <div className="slot-legend" aria-hidden="true">
        <span><i className="legend-available" />可选</span>
        <span><i className="legend-selected" />已选</span>
        <span><i className="legend-disabled" />不可选</span>
        <span><i className="legend-expired" />已过期</span>
      </div>
      <div className="slot-wall-scroll">
        <div className="slot-wall" role="grid" aria-label={`${room.name} 三天可用时间线`}>
          <div className="slot-wall-head">
            <div className="slot-day-spacer">日期</div>
            <UptimeKumaTicks />
          </div>
          {dates.map((date) => (
            <div className="slot-day-row" key={date} role="row">
              <div className="slot-day-label">
                <strong>{dayLabel(date)}</strong>
                <small>{rangeText(room.days[date] ?? [])}</small>
              </div>
              <UptimeKumaTimeline
                label={`${room.name} ${dayLabel(date)} 08:00 到 22:00 可选状态`}
                onSelect={(index) => choose(date, index)}
                onDragStart={(index) => {
                  drag.current = { date, anchor: index };
                  selectRange(date, index, index);
                }}
                onDragMove={(index) => {
                  if (drag.current?.date === date) selectRange(date, drag.current.anchor, index);
                }}
                onDragEnd={() => { drag.current = null; }}
                data={timeSlots.map((slot, index) => {
                  const expired = slotExpired(date, slot);
                  const available = !expired && room.reservable !== false && slotAvailable(room.days[date] ?? [], slot);
                  const selected = selectionContains(selection, date, index);
                  const end = minutesToTime(timeToMinutes(slot) + 30);
                  return {
                    key: `${date}-${slot}`,
                    state: selected ? "selected" : expired ? "expired" : available ? "available" : "empty",
                    tooltip: `${dayLabel(date)} ${slot}-${end} ${selected ? "已选" : expired ? "已过期" : available ? "可选" : "不可选"}`,
                    ariaLabel: `${dayLabel(date)} ${slot} 到 ${end}`,
                    disabled: !available,
                  };
                })}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="time-selection-note">
        {selection ? `${dayLabel(selection.date)} ${selection.startTime}-${selection.endTime}` : "选择同一天连续时间段，最多 2 小时"}
      </div>
    </div>
  );
}

function OrderedParticipantPicker({
  participants,
  selectedIds,
  onChange,
  selectedDate,
}: {
  participants: ReservationParticipant[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  selectedDate?: string | null;
}) {
  return (
    <section className="guest-picker" aria-label="选择预约成员">
      <div className="guest-picker-head">
        <div>
          <span className="eyebrow">预约成员</span>
          <h3>选择预约成员</h3>
        </div>
        <span>{selectedIds.length} 人</span>
      </div>
      <div className="guest-section">
        <div className="guest-section-title">
          <strong>我和小队成员</strong>
          <small>第一位成员将作为主预约人，积分必须大于 0</small>
        </div>
        <div className="guest-option-grid">
          {participants.map((participant) => {
            const order = selectedIds.indexOf(participant.id);
            const selected = order >= 0;
            const quota = selectedDate ? participant.reservationQuota?.find((item) => item.date === selectedDate) : undefined;
            return (
            <label className={`guest-option${order === 0 ? " primary-participant" : ""}`} key={participant.id}>
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onChange(selected ? selectedIds.filter((id) => id !== participant.id) : [...selectedIds, participant.id])}
              />
              <span>
                <strong>{participant.realName}{participant.isCurrentUser ? "（我）" : ""}</strong>
                <small>
                  {order === 0 ? "主预约人 · " : selected ? `第 ${order + 1} 位 · ` : ""}
                  {participant.totalScore == null ? "积分待确认" : `剩余 ${participant.totalScore} 分`}
                  {quota ? ` · 剩余预约 ${quota.remaining}/${quota.limit} 次` : ""}
                  {participant.teamName ? ` · ${participant.teamName}` : ""}
                </small>
              </span>
            </label>
            );
          })}
          {!participants.length ? <div className="guest-empty">暂时没有可选成员，请先邀请成员加入小队并完成校园账号连接</div> : null}
        </div>
      </div>
    </section>
  );
}

function AuthPanel({ onReady, toast }: { onReady: () => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  const [tab, setTab] = useState<"login" | "register" | "reset">("login");
  const [busy, setBusy] = useState("");
  const scope = useRef<HTMLElement>(null);

  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
    timeline
      .from(".auth-nav", { autoAlpha: 0, y: -16, duration: 0.55 })
      .from(".auth-copy > *", { autoAlpha: 0, y: 26, duration: 0.7, stagger: 0.08 }, "-=0.2")
      .from(".auth-card", { autoAlpha: 0, y: 32, scale: 0.975, duration: 0.85 }, "-=0.65");

    gsap.fromTo(".auth-inline-image", { scale: 0.82, autoAlpha: 0.45 }, {
      scale: 1,
      autoAlpha: 1,
      ease: "none",
      scrollTrigger: {
        trigger: ".auth-copy",
        start: "top 90%",
        end: "bottom 35%",
        scrub: 0.8,
      },
    });
    gsap.utils.toArray<HTMLElement>(".auth-capability").forEach((item, index) => {
      gsap.fromTo(item, { y: 18 + index * 8, scale: 0.97 }, {
        y: 0,
        scale: 1,
        ease: "none",
        scrollTrigger: {
          trigger: item,
          start: "top 96%",
          end: "top 72%",
          scrub: 0.55,
        },
      });
    });
  }, { scope });

  async function submit(path: string, event: FormEvent<HTMLFormElement>, success: string) {
    event.preventDefault();
    setBusy(path);
    try {
      await api(path, { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
      toast(success);
      if (path.endsWith("/login")) await onReady();
      if (path.endsWith("/register") || path.endsWith("/reset-password")) setTab("login");
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", true);
    } finally {
      setBusy("");
    }
  }

  async function sendCode(form: HTMLFormElement, purpose: "register" | "reset") {
    setBusy(purpose);
    try {
      const result = await api<{ queued: boolean; devCode?: string }>(
        purpose === "register" ? "/api/v1/auth/send-register-code" : "/api/v1/auth/send-reset-code",
        { method: "POST", body: JSON.stringify({ email: form.email.value }) },
      );
      toast(result.devCode ? `验证码已发送，本次验证码为 ${result.devCode}` : "验证码已发送，请查收邮箱");
    } catch (error) {
      toast(error instanceof Error ? error.message : "发送失败", true);
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="auth-page" ref={scope}>
      <header className="auth-nav">
        <BrandLockup />
        {tab === "login" ? <span className="auth-nav-note">从一个空闲时段开始</span> : <button type="button" onClick={() => setTab("login")}>返回登录</button>}
      </header>
      <div className="auth-layout">
        <section className="auth-copy">
          <h1>把研讨间<span className="auth-inline-image" aria-hidden="true" /><span className="auth-heading-tail">安排得更从容</span></h1>
          <p>看清未来三天的空闲时间，和固定成员一起预约，并在需要时提前安排签到与签退。</p>
          <div className="auth-capabilities" aria-label="主要功能">
            <article className="auth-capability">
              <strong>先看时间</strong>
              <span>连续比较三天内每间研讨间的可用时段。</span>
            </article>
            <article className="auth-capability">
              <strong>再选成员</strong>
              <span>按顺序选择同行成员，清楚确认积分与次数。</span>
            </article>
            <article className="auth-capability">
              <strong>提前安排</strong>
              <span>为开放日预约、签到和签退预留好时间。</span>
            </article>
          </div>
          <div className="auth-marquee" aria-hidden="true">
            <div>可用时间 · 小队协作 · 预约记录 · 签到签退 · 可用时间 · 小队协作 · 预约记录 · 签到签退</div>
          </div>
        </section>
        <section className="auth-card">
        {tab === "login" ? (
          <>
            <div className="auth-heading">
              <h2>继续你的安排</h2>
              <p>使用注册邮箱登录，查看可用时间和已有预约。</p>
            </div>
            <form onSubmit={(event) => submit("/api/v1/auth/login", event, "登录成功")} className="form-stack">
              <Field label="邮箱"><input name="email" type="email" autoComplete="email" required /></Field>
              <Field label="密码"><input name="password" type="password" autoComplete="current-password" required minLength={8} /></Field>
              <Button busy={busy === "/api/v1/auth/login"} type="submit">进入预约</Button>
            </form>
            <p className="auth-switch">
              没有账号？<button onClick={() => setTab("register")}>注册账号</button>
              <span>·</span>
              忘记密码？<button onClick={() => setTab("reset")}>重置密码</button>
            </p>
          </>
        ) : null}
        {tab === "register" ? (
          <>
            <div className="auth-heading">
              <button className="back-link" onClick={() => setTab("login")}>返回登录</button>
              <h2>开始使用</h2>
              <p>先验证常用邮箱，之后再连接校园统一认证。</p>
            </div>
            <form onSubmit={(event) => submit("/api/v1/auth/register", event, "注册成功，请登录")} className="form-stack">
              <Field label="邮箱"><input name="email" type="email" autoComplete="email" required /></Field>
              <Button type="button" variant="secondary" busy={busy === "register"} onClick={(event) => sendCode(event.currentTarget.form!, "register")}>发送验证码</Button>
              <Field label="验证码"><input name="code" required /></Field>
              <Field label="密码"><input name="password" type="password" autoComplete="new-password" required minLength={8} /></Field>
              <Button busy={busy === "/api/v1/auth/register"} type="submit">创建账号</Button>
            </form>
          </>
        ) : null}
        {tab === "reset" ? (
          <>
            <div className="auth-heading">
              <button className="back-link" onClick={() => setTab("login")}>返回登录</button>
              <h2>重置密码</h2>
              <p>验证注册邮箱后，为账号设置一个新密码。</p>
            </div>
            <form onSubmit={(event) => submit("/api/v1/auth/reset-password", event, "密码已更新")} className="form-stack">
              <Field label="邮箱"><input name="email" type="email" autoComplete="email" required /></Field>
              <Button type="button" variant="secondary" busy={busy === "reset"} onClick={(event) => sendCode(event.currentTarget.form!, "reset")}>发送验证码</Button>
              <Field label="验证码"><input name="code" required /></Field>
              <Field label="新密码"><input name="password" type="password" autoComplete="new-password" required minLength={8} /></Field>
              <Button busy={busy === "/api/v1/auth/reset-password"} type="submit">更新密码</Button>
            </form>
          </>
        ) : null}
        </section>
      </div>
      <footer className="auth-footer">
        <span>南京农业大学图书馆研讨间预约辅助工具</span>
        <span>账号信息仅用于完成你发起的预约操作</span>
      </footer>
    </main>
  );
}

function Shell({
  session,
  page,
  navigate,
  onLogout,
  children,
}: {
  session: Session;
  page: Page;
  navigate: (path: string) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const items: Array<{ id: Page; label: string; icon: ReactNode; admin?: boolean }> = [
    { id: "rooms", label: "研讨间", icon: <DoorOpen size={18} /> },
    { id: "tasks", label: "提前安排", icon: <ClipboardList size={18} /> },
    { id: "teams", label: "同行成员", icon: <UsersRound size={18} /> },
    { id: "history", label: "我的预约", icon: <History size={18} /> },
    { id: "admin", label: "运营管理", icon: <Shield size={18} />, admin: true },
  ];
  return (
    <div className="app-shell">
      <header className="top-nav">
        <button className="brand-button" onClick={() => navigate("/rooms")} aria-label="返回研讨间首页"><BrandLockup compact /></button>
        <nav className="nav-pills" aria-label="主要页面">
          {items.filter((item) => !item.admin || session.user.role === "ADMIN").map((item) => (
            <button key={item.id} className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(pagePath(item.id))}>{item.icon}{item.label}</button>
          ))}
        </nav>
        <div className="top-actions">
          <div className="user-chip"><CircleUserRound size={18} /><span>{session.user.realName ?? session.user.email}</span>{session.user.totalScore != null ? <span title={`当前可用积分 ${session.user.totalScore}`} className={`score-badge${session.user.totalScore >= 4 ? " full" : session.user.totalScore >= 2 ? " mid" : " low"}`}>{session.user.totalScore}</span> : null}</div>
          <button className="icon-button" onClick={onLogout} aria-label="退出登录"><LogOut size={18} /></button>
        </div>
      </header>
      {children}
    </div>
  );
}

function CredentialLockPage({
  session,
  refresh,
  toast,
  navigate,
  onLogout,
}: {
  session: Session;
  refresh: () => Promise<void>;
  toast: (message: string, error?: boolean) => void;
  navigate: (path: string) => void;
  onLogout: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const attempt = session.credential.login_attempt;
  const waiting = attempt?.status === "QUEUED" || attempt?.status === "RUNNING" || attempt?.status === "SMS_REQUIRED";

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [waiting, attempt?.attemptId, refresh]);

  return (
    <div className="credential-lock-page">
      <button className="icon-button credential-lock-logout" onClick={onLogout} aria-label="退出登录" type="button">
        <LogOut size={18} />
      </button>
      <section className="credential-lock-panel">
        <div className="credential-lock-mark"><KeyRound size={22} /></div>
        <div className="credential-intro">
          <span className="status-pill">{credentialStatusText(session.credential.credential_status)}</span>
          <h1>连接校园统一认证</h1>
          <p>完成连接后，即可查询研讨间、提交预约并完成签到与签退。账号信息仅用于你发起的图书馆预约。</p>
        </div>
        {attempt?.status === "SMS_REQUIRED" ? <form className="credential-form" onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = formData(form);
          setBusy(true);
          try {
            await api("/api/v1/credentials/sms", { method: "POST", body: JSON.stringify({ attemptId: attempt.attemptId, code: data.code }) });
            toast("验证码已提交");
            await refresh();
            form.reset();
          } catch (error) {
            toast(error instanceof Error ? error.message : "验证码提交失败", true);
          } finally {
            setBusy(false);
          }
        }}>
          <div className="credential-progress"><Loader2 className="spin" size={18} /><span>{attempt.progress}</span></div>
          <Field label="短信验证码"><input name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" autoFocus /></Field>
          <Button busy={busy}>提交验证码</Button>
        </form> : waiting ? <div className="credential-progress"><Loader2 className="spin" size={20} /><span>{attempt?.progress ?? "正在准备统一认证"}</span></div> : <form className="credential-form" onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = formData(form);
          setBusy(true);
          try {
            const endpoint = session.credential.login_student_id ? "/api/v1/credentials/rebind" : "/api/v1/credentials/bind";
            await api(endpoint, { method: "POST", body: JSON.stringify(data) });
            toast("正在连接校园账号");
            await refresh();
            form.reset();
          } catch (error) {
            toast(error instanceof Error ? error.message : "暂时无法连接校园账号", true);
          } finally {
            setBusy(false);
          }
        }}>
          {attempt?.errorMessage ? <div className="credential-error">{attempt.errorMessage}</div> : null}
          <Field label="学号"><input name="studentId" required maxLength={32} defaultValue={session.credential.login_student_id ?? session.user.studentId ?? ""} autoComplete="username" autoFocus /></Field>
          <Field label="统一认证密码"><input name="password" type="password" required maxLength={128} autoComplete="current-password" /></Field>
          <Button busy={busy}>连接校园账号</Button>
        </form>}
      </section>
    </div>
  );
}

function RoomsPage({ toast, navigate }: { toast: (message: string, error?: boolean) => void; navigate: (path: string) => void }) {
  const fallbackDates = useMemo(() => threeDayDates(), []);
  const [dates, setDates] = useState<string[]>(fallbackDates);
  const [rooms, setRooms] = useState<RoomWithDays[]>([]);
  const [busy, setBusy] = useState(false);
  const [cache, setCache] = useState<RoomsResponse["cache"]>();

  async function loadRooms(refresh = false) {
    setBusy(true);
    try {
      if (refresh) {
        const job = await api<GatewayJob>("/api/v1/rooms/refresh", { method: "POST" });
        await waitForGatewayJob(job);
      }
      const response = await api<RoomsResponse>("/api/v1/rooms");
      const normalized = normalizeRooms(response, fallbackDates);
      setDates(normalized.dates);
      setRooms(normalized.rooms.filter((room) => room.reservable !== false));
      setCache(response.cache);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void loadRooms(); }, []);

  return (
    <div className="room-list-page">
      <PageIntro
        title="今天想约哪一间？"
        description="从未来三天的空闲时间开始选择，进入房间后再确认同行成员。"
        action={<Button onClick={() => loadRooms(true)} busy={busy} type="button" variant="secondary"><RefreshCw size={16} />更新可用时间</Button>}
      />
      <Card title="未来三天的可用时间" icon={<CalendarClock size={20} />}>
        <div className="three-day-head">
          <div>
            <div className="date-strip">{dates.map((date) => <span key={date}>{dayLabel(date)}</span>)}</div>
            <small className={`cache-status ${cache?.status?.toLowerCase() ?? "miss"}`}>
              {cache?.status === "FRESH" ? "可用时间已更新" : cache?.status === "STALE" ? "当前信息可能不是最新" : cache?.status === "EXPIRED" ? "请更新可用时间" : "正在获取可用时间"}
              {cache?.refreshedAt ? ` · 更新于 ${formatTimestamp(cache.refreshedAt)}` : ""}
            </small>
          </div>
        </div>
        <div className="room-grid">
          {rooms.map((room) => (
            <button
              type="button"
              key={room.id}
              className="room-card"
              onClick={() => navigate(`/rooms/${room.id}`)}
            >
              <div className="room-card-main">
                <strong>{room.name}</strong>
                <span>{room.roomLocation ?? "研讨室"} · {room.minReservationNum}-{room.maxNum} 人</span>
              </div>
              <RoomAvailabilityHistory dates={dates} room={room} />
            </button>
          ))}
        </div>
        {!rooms.length && !busy ? <Empty>未来三天暂时没有空闲研讨间。稍后更新一次，或换个时间再来看看。</Empty> : null}
      </Card>
    </div>
  );
}

function RoomDetailPage({
  roomId,
  session,
  toast,
  navigate,
}: {
  roomId: number;
  session: Session;
  toast: (message: string, error?: boolean) => void;
  navigate: (path: string) => void;
}) {
  const fallbackDates = useMemo(() => threeDayDates(), []);
  const [dates, setDates] = useState<string[]>(fallbackDates);
  const [room, setRoom] = useState<RoomWithDays | null>(null);
  const [selection, setSelection] = useState<TimeSelection | null>(null);
  const [participants, setParticipants] = useState<ReservationParticipant[]>([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const primaryParticipant = participants.find((participant) => participant.id === selectedParticipantIds[0]) ?? null;

  async function loadRoom(refresh = false) {
    setBusy(true);
    try {
      if (refresh) {
        const job = await api<GatewayJob>("/api/v1/rooms/refresh", { method: "POST" });
        await waitForGatewayJob(job);
      }
      const participantRefresh = await api<GatewayJob | { participants: ReservationParticipant[] }>("/api/v1/reservation-participants/refresh", { method: "POST" });
      if ("jobId" in participantRefresh) await waitForGatewayJob(participantRefresh);
      const [response, participantData] = await Promise.all([
        api<RoomsResponse>("/api/v1/rooms"),
        api<{ participants: ReservationParticipant[] }>("/api/v1/reservation-participants"),
      ]);
      const normalized = normalizeRooms(response, fallbackDates);
      const availableRooms = normalized.rooms.filter((item) => item.reservable !== false);
      setDates(normalized.dates);
      setRoom(availableRooms.find((item) => item.id === roomId) ?? null);
      setParticipants(participantData.participants);
      setSelection(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void loadRoom(); }, [roomId]);

  async function reserve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!room || !selection || room.reservable === false) return;
    if (!selectedParticipantIds.length || !primaryParticipant) {
      toast("请至少选择一位预约成员", true);
      return;
    }
    if (selectedParticipantIds.length < room.minReservationNum) {
      toast(`该房间至少需要 ${room.minReservationNum} 人`, true);
      return;
    }
    if (selectedParticipantIds.length > room.maxNum) {
      toast(`该房间最多允许 ${room.maxNum} 人`, true);
      return;
    }
    if (primaryParticipant.totalScore == null || primaryParticipant.totalScore <= 0) {
      toast("主预约人积分必须大于 0，当前积分暂不可用或已用尽", true);
      return;
    }
    setSubmitting(true);
    try {
      const job = await api<GatewayJob>("/api/v1/reservations/manual", {
        method: "POST",
        body: JSON.stringify({
          date: selection.date,
          roomId: room.id,
          startTime: selection.startTime,
          endTime: selection.endTime,
          primaryUserId: selectedParticipantIds[0],
          participantUserIds: selectedParticipantIds,
        }),
      });
      await waitForGatewayJob(job);
      toast("预约已提交");
      setSelection(null);
      setSelectedParticipantIds([]);
      await loadRoom();
    } catch (error) {
      toast(error instanceof Error ? error.message : "预约失败", true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="room-detail-page">
      <button className="back-button" type="button" onClick={() => navigate("/rooms")}>
        <ChevronLeft size={18} />返回房间
      </button>
      <PageIntro
        title={room ? `预约 ${room.name}` : "选择预约时间"}
        description="依次确认时间、主预约人和同行成员，提交前仍可随时调整。"
      />
      <Card title="确认时间与成员" icon={<DoorOpen size={20} />}>
        {busy ? <Empty>正在获取可预约时间</Empty> : null}
        {!busy && !room ? <Empty>这个研讨间当前不可预约或已下线</Empty> : null}
        {room ? (
          <form className="form-stack" onSubmit={reserve}>
            <div className="room-detail-head">
              <div>
                <h2>{room.name}</h2>
                <p>{room.roomLocation ?? "研讨室"} · {room.minReservationNum}-{room.maxNum} 人 · {room.reservable === false ? "当前不可预约" : "可预约"}</p>
              </div>
              <Button className="desktop-only-action" onClick={() => loadRoom(true)} busy={busy} type="button" variant="secondary"><RefreshCw size={16} />更新时间</Button>
            </div>
            {room.reservable === false ? <div className="room-warning">这个研讨间当前暂停预约，你仍可查看已有时间安排。</div> : null}
            <SquareTimeGridPicker dates={dates} room={room} selection={selection} onChange={setSelection} />
            <OrderedParticipantPicker participants={participants} selectedIds={selectedParticipantIds} onChange={setSelectedParticipantIds} selectedDate={selection?.date} />
            <div className="reservation-summary">
              <div>
                <span className="eyebrow">提交前确认</span>
                <strong>{selection ? `${dayLabel(selection.date)} ${selection.startTime}-${selection.endTime}` : "尚未选择时间段"}</strong>
                <small>{primaryParticipant ? `主预约人：${primaryParticipant.realName} · 共 ${selectedParticipantIds.length} 人` : "请选择成员，第一位将作为主预约人"}</small>
                <small className={!primaryParticipant || primaryParticipant.totalScore == null || primaryParticipant.totalScore <= 0 ? "score-warning" : ""}>
                  {primaryParticipant ? `主预约人剩余积分：${primaryParticipant.totalScore ?? "待确认"}（必须大于 0）` : "尚未选择主预约人"}
                </small>
              </div>
              <Button disabled={!selection || !selectedParticipantIds.length || room.reservable === false || !primaryParticipant || primaryParticipant.totalScore == null || primaryParticipant.totalScore <= 0} busy={submitting}>提交预约</Button>
            </div>
          </form>
        ) : null}
      </Card>
    </div>
  );
}

function TasksPage({
  toast,
  navigate,
  mode = "list",
}: {
  toast: (message: string, error?: boolean) => void;
  navigate: (path: string) => void;
  mode?: "list" | "new";
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workflows, setWorkflows] = useState<SignWorkflow[]>([]);
  const [rooms, setRooms] = useState<RoomWithDays[]>([]);
  const [participants, setParticipants] = useState<ReservationParticipant[]>([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [taskType, setTaskType] = useState<"reservation" | "sign">("reservation");
  const [roomId, setRoomId] = useState("");
  const [reservationOptions, setReservationOptions] = useState<ReservationOption[]>([]);
  const [reservationOptionId, setReservationOptionId] = useState("");
  const [taskTimeSelection, setTaskTimeSelection] = useState<TimeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [optionBusy, setOptionBusy] = useState(false);
  const targetDate = addDays(today(), 3);
  const taskTimeRoom = useMemo<RoomWithDays>(() => ({
    id: 0,
    name: "提前安排",
    maxNum: 20,
    minReservationNum: 1,
    reservable: true,
    days: { [targetDate]: [{ startTime: "08:00", endTime: "22:00" }] },
  }), [targetDate]);
  const selectedReservationOption = reservationOptions.find((option) => option.id === reservationOptionId) ?? null;

  async function load() {
    try {
      const participantRefresh = await api<GatewayJob | { participants: ReservationParticipant[] }>("/api/v1/reservation-participants/refresh", { method: "POST" });
      if ("jobId" in participantRefresh) await waitForGatewayJob(participantRefresh);
      const [reservationTasks, signWorkflows, roomResponse, participantResponse] = await Promise.all([
        api<Task[]>("/api/v1/reservation-tasks"),
        api<SignWorkflow[]>("/api/v1/sign-workflows").catch(() => []),
        api<RoomsResponse>("/api/v1/rooms"),
        api<{ participants: ReservationParticipant[] }>("/api/v1/reservation-participants"),
      ]);
      setTasks(reservationTasks);
      setWorkflows(signWorkflows);
      setRooms(normalizeRooms(roomResponse, threeDayDates()).rooms.filter((room) => room.reservable !== false));
      setParticipants(participantResponse.participants);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = formData(form);
    if (taskType === "reservation" && (!selectedParticipantIds.length || !roomId || !taskTimeSelection)) {
      toast("请选择研讨间、预约时间和预约成员", true);
      return;
    }
    if (taskType === "sign" && !reservationOptionId) {
      toast("请选择已有预约", true);
      return;
    }
    setBusy(true);
    try {
      if (taskType === "reservation") {
        await api("/api/v1/reservation-tasks", {
          method: "POST",
          body: JSON.stringify({
            targetDate,
            startTime: taskTimeSelection!.startTime,
            endTime: taskTimeSelection!.endTime,
            roomId: Number(roomId),
            primaryUserId: selectedParticipantIds[0],
            participantUserIds: selectedParticipantIds,
          }),
        });
      } else {
        if (!selectedReservationOption) throw new Error("请先查找并选择一条进行中的预约");
        await api("/api/v1/sign-workflows", {
          method: "POST",
          body: JSON.stringify({
            reservationOptionId: selectedReservationOption.id,
            signAdvanceMinutes: Number(data.signAdvanceMinutes),
            signoutAdvanceMinutes: Number(data.signoutAdvanceMinutes),
          }),
        });
      }
      toast("安排已保存");
      form.reset();
      setSelectedParticipantIds([]);
      setRoomId("");
      setReservationOptions([]);
      setReservationOptionId("");
      setTaskTimeSelection(null);
      await load();
      navigate("/tasks");
    } catch (error) {
      toast(error instanceof Error ? error.message : "创建失败", true);
    } finally {
      setBusy(false);
    }
  }

  async function refreshOptions() {
    setOptionBusy(true);
    try {
      const response = await api<GatewayJob<{ options: ReservationOption[] }> | { options: ReservationOption[] }>("/api/v1/reservation-options/refresh", {
        method: "POST",
      });
      const result = "jobId" in response ? await waitForGatewayJob(response) : response;
      setReservationOptions(result.options);
      setReservationOptionId(result.options[0]?.id ?? "");
      toast(result.options.length ? `找到 ${result.options.length} 条进行中的预约` : "没有找到可管理的预约", !result.options.length);
    } catch (error) {
      toast(error instanceof Error ? error.message : "查找预约失败", true);
    } finally {
      setOptionBusy(false);
    }
  }

  async function action(id: string, actionName: "enable" | "cancel") {
    try {
      await api(`/api/v1/reservation-tasks/${id}/${actionName}`, { method: "POST" });
      toast("安排已更新");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", true);
    }
  }

  async function cancelWorkflow(id: string) {
    try {
      await api(`/api/v1/sign-workflows/${id}/cancel`, { method: "POST" });
      toast("安排已取消");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "取消失败", true);
    }
  }

  if (mode === "new") {
    return (
      <div className="compact-page">
        <button className="back-button" type="button" onClick={() => navigate("/tasks")}>
          <ChevronLeft size={18} />返回提前安排
        </button>
      <PageIntro title="提前安排下一次预约" description="预约开放后将按你确认的房间、时间和成员尝试提交；签到与签退仅用于已有预约。" />
      <Card title="填写安排" icon={<ClipboardList size={20} />}>
        <form className="form-grid" onSubmit={create}>
          <Field label="你希望提前做什么">
            <select value={taskType} onChange={(event) => {
              const next = event.target.value as "reservation" | "sign";
              setTaskType(next);
              setReservationOptions([]);
              setReservationOptionId("");
              setTaskTimeSelection(null);
              if (next === "sign") void refreshOptions();
            }}>
              <option value="reservation">开放后尝试预约</option>
              <option value="sign">按时签到与签退</option>
            </select>
          </Field>
          {taskType === "reservation" ? (
            <>
              <Field label="房间">
                <select value={roomId} onChange={(event) => setRoomId(event.target.value)} required>
                  <option value="">请选择研讨间</option>
                  {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                </select>
              </Field>
              <Field label="预约日期"><input value={targetDate} readOnly /></Field>
              <div className="form-grid-wide task-time-row">
                <SquareTimeGridPicker dates={[targetDate]} room={taskTimeRoom} selection={taskTimeSelection} onChange={setTaskTimeSelection} />
              </div>
            </>
          ) : (
            <>
              <div className="form-grid-wide reservation-option-panel">
                <div className="toolbar">
                  <Button type="button" variant="secondary" busy={optionBusy} onClick={() => void refreshOptions()}><RefreshCw size={16} />查找已有预约</Button>
                </div>
                <Field label="已有预约">
                  <select value={reservationOptionId} onChange={(event) => setReservationOptionId(event.target.value)} required>
                    <option value="">请选择已有预约</option>
                    {reservationOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.roomName} · {option.date} {option.startTime}-{option.endTime} · {option.participants.map((participant) => participant.realName).join("、")}</option>
                    ))}
                  </select>
                </Field>
                {selectedReservationOption ? (
                  <div className="locked-reservation-members">
                    <strong>签到成员</strong>
                    <span>{selectedReservationOption.participants.map((participant) => `${participant.realName}${participant.isPrimary ? "（主预约人）" : ""}`).join("、")}</span>
                    <small>将依次为这些成员签到；签退从主预约人开始处理。</small>
                  </div>
                ) : null}
              </div>
              <Field label="提前签到（分钟）"><input name="signAdvanceMinutes" type="number" min="0" max="60" defaultValue="15" required /></Field>
              <Field label="提前签退（分钟）"><input name="signoutAdvanceMinutes" type="number" min="0" max="60" defaultValue="10" required /></Field>
            </>
          )}
          {taskType === "reservation" ? (
            <div className="form-grid-wide">
              <OrderedParticipantPicker participants={participants} selectedIds={selectedParticipantIds} onChange={setSelectedParticipantIds} selectedDate={targetDate} />
            </div>
          ) : null}
          <Button busy={busy}>保存安排<ArrowRight size={16} /></Button>
        </form>
      </Card>
      </div>
    );
  }

  return (
    <div className="compact-page">
      <PageIntro
        title="把下一步提前安排好"
        description="查看尚未开始、正在进行和已经完成的预约与签到安排。"
        action={<Button type="button" onClick={() => navigate("/tasks/new")}><ClipboardList size={16} />新增安排</Button>}
      />
      <Card title="我的提前安排" icon={<History size={20} />}>
        <div className="toolbar page-toolbar">
          <Button type="button" variant="secondary" onClick={load}><RefreshCw size={16} />更新安排</Button>
        </div>
        <div className="task-sections">
          <section className="task-section">
            <div className="section-subtitle"><strong>预约开放后提交</strong><span>{tasks.length} 项</span></div>
            <div className="list">
              {tasks.map((task) => (
                <article className="list-row" key={String(task.id)}>
                  <div><strong>{String(task.target_date)} {String(task.start_time)}-{String(task.end_time)}</strong><span>{statusText(task.status as string | number | null | undefined)} · {taskCandidateText(task)}</span></div>
                  <div className="row-actions">
                    {["DRAFT", "WAITING_WINDOW", "WAITING_MEMBERS", "READY"].includes(String(task.status)) ? <Button variant="ghost" onClick={() => action(String(task.id), "cancel")}>取消</Button> : null}
                  </div>
                </article>
              ))}
              {!tasks.length ? <Empty>还没有提前安排的预约。开放日前确认好时间和成员，会更从容。</Empty> : null}
            </div>
          </section>
          <section className="task-section">
            <div className="section-subtitle"><strong>签到签退</strong><span>{workflows.length} 项</span></div>
            <div className="list">
              {workflows.map((workflow) => (
                <article className="list-row" key={workflow.id}>
                  <div>
                    <strong>{workflow.room_name_snapshot} · {workflow.date} {workflow.start_time}-{workflow.end_time}</strong>
                    <span>{statusText(workflow.status)} · 签到 {formatTimestamp(workflow.sign_scheduled_at)} · 签退 {formatTimestamp(workflow.signout_scheduled_at)}</span>
                    <span>{workflow.participants.map((participant) => `${participant.realName}: ${statusText(participant.signStatus)}`).join(" · ")} · 签退 {statusText(workflow.signout_status)}</span>
                  </div>
                  <div className="row-actions">
                    {workflow.status === "ACTIVE" ? <Button variant="ghost" onClick={() => void cancelWorkflow(workflow.id)}>取消</Button> : null}
                  </div>
                </article>
              ))}
              {!workflows.length ? <Empty>还没有签到或签退安排。已有预约后，可在这里补充。</Empty> : null}
            </div>
          </section>
        </div>
      </Card>
    </div>
  );
}

function TeamsPage({
  toast,
  navigate,
  mode = "list",
  inviteTeamId,
}: {
  toast: (message: string, error?: boolean) => void;
  navigate: (path: string) => void;
  mode?: "list" | "new";
  inviteTeamId?: string;
}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<InvitableUser[]>([]);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [teamMetrics, setTeamMetrics] = useState<Record<string, Array<{
    localUserId: string;
    realName: string;
    totalScore: number | null;
    reservationQuota: Array<{ date: string; remaining: number; limit: number }>;
  }>>>({});

  async function load(refreshScores = false) {
    try {
      const [teamData, invitable] = await Promise.all([
        api<{ teams: Team[]; invitations?: TeamInvitation[] }>("/api/v1/teams/mine"),
        api<InvitableUser[]>("/api/v1/users/invitable").catch(() => []),
      ]);
      setTeams(teamData.teams);
      setInvitations(teamData.invitations ?? []);
      setUsers(invitable);
      const metrics: Record<string, Array<{
        localUserId: string;
        realName: string;
        totalScore: number | null;
        reservationQuota: Array<{ date: string; remaining: number; limit: number }>;
      }>> = {};
      for (const team of teamData.teams) {
        try {
          if (refreshScores) {
            const refreshed = await api<GatewayJob | { members: unknown[] }>(`/api/v1/teams/${encodeURIComponent(team.id)}/member-metrics`, { method: "POST" });
            if ("jobId" in refreshed) await waitForGatewayJob(refreshed);
          }
          const result = await api<{ members: Array<{ localUserId: string; realName: string; totalScore: number | null; reservationQuota: Array<{ date: string; remaining: number; limit: number }> }> }>(`/api/v1/teams/${encodeURIComponent(team.id)}/member-metrics`);
          metrics[team.id] = result.members;
        } catch { metrics[team.id] = []; }
      }
      setTeamMetrics(metrics);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(true); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = formData(form);
    try {
      await api("/api/v1/teams", { method: "POST", body: JSON.stringify(data) });
      toast("小队已创建");
      form.reset();
      await load();
      navigate("/teams");
    } catch (error) {
      toast(error instanceof Error ? error.message : "创建失败", true);
    }
  }

  async function invite(teamId: string, inviteeUserId: string) {
    try {
      await api(`/api/v1/teams/${teamId}/invitations`, { method: "POST", body: JSON.stringify({ inviteeUserId }) });
      toast("邀请已发送");
    } catch (error) {
      toast(error instanceof Error ? error.message : "邀请失败", true);
    }
  }

  async function respond(invitationId: string, action: "accept" | "reject") {
    try {
      await api(`/api/v1/team-invitations/${invitationId}/respond`, { method: "POST", body: JSON.stringify({ action }) });
      toast(action === "accept" ? "已加入小队" : "已拒绝邀请");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "处理失败", true);
    }
  }

  async function manageTeam(path: string, confirmation: string, success: string) {
    if (!window.confirm(confirmation)) return;
    try {
      await api(path, { method: "DELETE" });
      toast(success);
      await load(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", true);
    }
  }

  const leaderTeams = teams.filter(isTeamLeader);
  const canCreateTeam = leaderTeams.length === 0;

  if (mode === "new") {
    if (!canCreateTeam && teams.length) {
      return (
        <div className="compact-page">
          <button className="back-button" type="button" onClick={() => navigate("/teams")}>
            <ChevronLeft size={18} />返回同行成员
          </button>
          <PageIntro title="建立固定同行成员" description="每个人只能创建一个小队，但仍可接受其他同学的邀请。" />
          <Card title="暂时无法新建" icon={<UsersRound size={20} />}>
            <Empty>你已经创建了一个小队。可以继续邀请成员，或加入其他同学的小队。</Empty>
          </Card>
        </div>
      );
    }
    return (
      <div className="compact-page">
        <button className="back-button" type="button" onClick={() => navigate("/teams")}>
          <ChevronLeft size={18} />返回同行成员
        </button>
      <PageIntro title="建立固定同行成员" description="为经常一起使用研讨间的同学建立小队，之后选择成员会更快。" />
      <Card title="填写小队信息" icon={<UsersRound size={20} />}>
        <form className="form-stack" onSubmit={create}>
          <Field label="小队名称"><input name="name" required maxLength={50} placeholder="例如：植保 2301 学习小组" /></Field>
          <Field label="小队说明"><input name="description" maxLength={120} placeholder="简单说明小队用途，可不填" /></Field>
          <Button>创建小队</Button>
        </form>
      </Card>
      </div>
    );
  }

  if (inviteTeamId) {
    const team = teams.find((item) => item.id === inviteTeamId);
    const memberIds = new Set(team ? parseTeamMembers(team.members).map((member) => member.id) : []);
    const inviteUsers = users.filter((user) => !memberIds.has(user.id));
    return (
      <div className="compact-page">
        <button className="back-button" type="button" onClick={() => navigate("/teams")}>
          <ChevronLeft size={18} />返回同行成员
        </button>
        <PageIntro title={team ? `邀请成员加入 ${team.name}` : "邀请同行成员"} description="邀请发出后，对方可以在自己的同行成员页面接受或拒绝。" />
        <Card title={team ? `邀请成员加入 ${team.name}` : "邀请成员"} icon={<Mail size={20} />}>
          {!team ? <Empty>这个小队可能已被删除或你已不在队内</Empty> : null}
          {team && !isTeamLeader(team) ? <Empty>只有小队创建者可以邀请新成员</Empty> : null}
          {team && isTeamLeader(team) ? (
            <div className="invite-user-grid">
              {inviteUsers.map((user) => (
                <article className="invite-user-card" key={user.id}>
                  <div className="invite-user-avatar"><CircleUserRound size={18} /></div>
                  <div>
                    <strong>{user.real_name ?? user.email}</strong>
                    <span>{user.student_id ? `${user.student_id} · ${user.email}` : user.email}</span>
                  </div>
                  <Button type="button" variant="secondary" onClick={() => invite(team.id, user.id)}>发送邀请</Button>
                </article>
              ))}
              {!inviteUsers.length ? <Empty>当前没有其他可邀请成员</Empty> : null}
            </div>
          ) : null}
        </Card>
      </div>
    );
  }

  const pendingInvitations = invitations.filter((invitation) => invitation.status === "PENDING");

  return (
    <div className="compact-page">
      <PageIntro
        title="和熟悉的人一起预约"
        description="集中查看成员的可用积分与今日预约次数，提交前更容易选对主预约人。"
        action={<Button type="button" disabled={!canCreateTeam} onClick={() => navigate("/teams/new")}><UsersRound size={16} />{canCreateTeam ? "新建小队" : "已创建小队"}</Button>}
      />
      <Card title="我的同行成员" icon={<Mail size={20} />}>
        <div className="toolbar page-toolbar">
          <Button type="button" variant="secondary" onClick={() => load(true)}><RefreshCw size={16} />更新成员信息</Button>
        </div>
        {pendingInvitations.length ? (
          <div className="list team-invitation-list">
            {pendingInvitations.map((invitation) => (
              <article className="list-row" key={invitation.id}>
                <div>
                  <strong>{invitation.team_name}</strong>
                  <span>{invitation.inviter_name ?? "成员"} 邀请你加入</span>
                </div>
                <div className="row-actions">
                  <Button type="button" variant="secondary" onClick={() => respond(invitation.id, "reject")}>拒绝</Button>
                  <Button type="button" onClick={() => respond(invitation.id, "accept")}>接受</Button>
                </div>
              </article>
            ))}
          </div>
        ) : null}
        <div className="list">
          {teams.map((team) => (
            <article className="list-row" key={team.id}>
              <div>
                <strong>{team.name}</strong>
                <span>{team.description || "暂未填写小队说明"} · {visibleTeamMembers(team).length} 人 · {isTeamLeader(team) ? "由我创建" : "我已加入"}</span>
                <div className="team-member-strip">
                  {visibleTeamMembers(team).map((member) => {
                    const memberMetric = teamMetrics[team.id]?.find((metric) => metric.localUserId === member.id);
                    const quota = memberMetric?.reservationQuota.find((item) => item.date === today());
                    const scoreText = memberMetric?.totalScore != null ? `${memberMetric.totalScore} 分` : "积分待确认";
                    return (
                      <span key={`${team.id}-${member.id}`} className={member.role === "队长" ? "leader" : ""}>
                        {member.name}
                        <small>{member.role} · {scoreText}{quota ? ` · 今日剩余 ${quota.remaining}/${quota.limit} 次` : ""}</small>
                        {isTeamLeader(team) && member.role !== "队长" ? (
                          <button type="button" className="team-member-action" onClick={() => void manageTeam(
                            `/api/v1/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`,
                            `确认将 ${member.name} 移出小队？`,
                            "队员已移出",
                          )}>移出</button>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="row-actions team-actions">
                {isTeamLeader(team) ? <Button type="button" variant="secondary" onClick={() => navigate(`/teams/${encodeURIComponent(team.id)}/invite`)}>邀请成员</Button> : null}
                {isTeamLeader(team) ? (
                  <Button type="button" variant="ghost" onClick={() => void manageTeam(
                    `/api/v1/teams/${encodeURIComponent(team.id)}`,
                    `确认解散小队“${team.name}”？`,
                    "小队已解散",
                  )}>解散小队</Button>
                ) : (
                  <Button type="button" variant="ghost" onClick={() => void manageTeam(
                    `/api/v1/teams/${encodeURIComponent(team.id)}/members/me`,
                    `确认退出小队“${team.name}”？`,
                    "已退出小队",
                  )}>退出小队</Button>
                )}
              </div>
            </article>
          ))}
          {!teams.length ? <Empty>这里还没有同行成员。新建一个小队，邀请经常一起预约的同学加入。</Empty> : null}
        </div>
      </Card>
    </div>
  );
}

function HistoryPage({ toast }: { toast: (message: string, error?: boolean) => void }) {
  const [items, setItems] = useState<Reservation[]>([]);
  const [page, setPage] = useState(1);
  const pageSize = 8;

  async function load(sync = false) {
    try {
      if (sync) {
        const job = await api<GatewayJob>("/api/v1/reservations/sync", { method: "POST" });
        await waitForGatewayJob(job);
      }
      setItems(await api<Reservation[]>("/api/v1/reservations/history"));
      setPage(1);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, []);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  async function action(id: string, actionName: "cancel" | "signout") {
    try {
      const job = await api<GatewayJob<{ url?: string }>>(`/api/v1/reservations/${id}/${actionName}`, { method: "POST" });
      const result = await waitForGatewayJob(job);
      if (result.url) window.open(result.url, "_blank", "noopener,noreferrer");
      toast("预约已更新");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", true);
    }
  }

  return (
    <div className="compact-page">
      <PageIntro
        title="每一次预约，都在这里"
        description="查看预约时间、当前进度，并在允许的时间内取消或签退。"
        action={<Button type="button" variant="secondary" onClick={() => load(true)}><RefreshCw size={16} />更新预约记录</Button>}
      />
    <Card title="我的预约" icon={<History size={20} />}>
      <div className="list">
        {visibleItems.map((item) => (
          <article className="list-row" key={String(item.id)}>
            <div>
              <strong>{item.room_name_snapshot} · {item.date} {item.start_time}-{item.end_time}</strong>
              <span>{String(item.statusLabel ?? item.status_label ?? item.status)} · 预约编号 {String(item.official_reservation_id ?? "正在获取")}</span>
            </div>
            <div className="row-actions">
              {item.status === "SIGNED_IN" ? <Button variant="secondary" onClick={() => action(String(item.id), "signout")}>签退</Button> : null}
              {item.canCancel || item.can_cancel ? <Button variant="ghost" onClick={() => action(String(item.id), "cancel")}>取消</Button> : null}
            </div>
          </article>
        ))}
        {!items.length ? <Empty>还没有预约记录。从研讨间页面选择一个空闲时段开始吧。</Empty> : null}
      </div>
      {items.length > pageSize ? (
        <div className="pagination">
          <Button type="button" variant="secondary" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button>
          <span>{currentPage} / {totalPages}</span>
          <Button type="button" variant="secondary" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</Button>
        </div>
      ) : null}
    </Card>
    </div>
  );
}

type AdminOverview = {
  active_users?: number;
  active_credentials?: number;
  open_tasks?: number;
  pending_emails?: number;
};

const adminFieldLabels: Record<string, string> = {
  user_id: "用户标识",
  reservation_id: "预约标识",
  team_id: "小队标识",
  real_name: "姓名",
  email: "邮箱",
  role: "身份",
  status: "当前情况",
  student_id: "学号",
  created_at: "加入时间",
  last_login_at: "最近登录",
  credential_status: "校园账号",
  last_refresh_success_at: "最近连接",
  last_error_message: "需要关注",
  target_date: "日期",
  date: "日期",
  start_time: "开始",
  end_time: "结束",
  room_name_snapshot: "研讨间",
  name: "名称",
  description: "说明",
  leader_name: "创建者",
  recipient_email: "收件人",
  template: "通知内容",
  attempt_count: "尝试次数",
  next_attempt_at: "下次尝试",
  sent_at: "送达时间",
  action: "操作",
  result: "结果",
  actor_type: "操作来源",
  target_type: "影响对象",
  kind: "内容",
  error_message: "未完成原因",
  started_at: "开始时间",
  finished_at: "完成时间",
  refreshed_at: "更新时间",
  fresh_until: "有效至",
};

const adminPreferredColumns: Record<string, string[]> = {
  users: ["real_name", "email", "student_id", "role", "status", "last_login_at"],
  credentials: ["user_id", "credential_status", "last_refresh_success_at", "refresh_failure_count", "last_error_message"],
  tasks: ["target_date", "start_time", "end_time", "status", "created_at"],
  reservations: ["room_name_snapshot", "date", "start_time", "end_time", "status", "created_at"],
  invitations: ["invitee_real_name", "invitee_student_id", "status", "expires_at", "created_at"],
  teams: ["name", "description", "leader_name", "created_at"],
  "team-invitations": ["team_id", "status", "expires_at", "responded_at"],
  "sign-tasks": ["reservation_id", "scheduled_at", "status", "attempt_count", "executed_at"],
  "signout-tasks": ["reservation_id", "scheduled_at", "status", "attempt_count", "executed_at"],
  emails: ["recipient_email", "template", "status", "attempt_count", "next_attempt_at", "sent_at"],
  "audit-logs": ["action", "actor_type", "target_type", "result", "created_at"],
  "gateway-jobs": ["kind", "status", "attempt_count", "error_message", "started_at", "finished_at"],
  "gateway-snapshots": ["kind", "scope", "version", "refreshed_at", "fresh_until", "last_error_message"],
};

function adminRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return [value];
  return [];
}

function adminValue(key: string, value: unknown, collection: string): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (key === "role") return String(value) === "ADMIN" ? "管理员" : "普通用户";
  if (key === "status" && collection === "users") return String(value) === "ACTIVE" ? "正常使用" : "已停用";
  if (key === "credential_status") return credentialStatusText(String(value));
  if (key === "status" && collection === "emails") return String(value) === "PENDING" ? "等待发送" : statusText(String(value));
  if (key === "status" || key.endsWith("_status") || key === "result") return statusText(String(value));
  if (key.endsWith("_at") || key.endsWith("_until")) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) return formatTimestamp(numeric);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function AdminRecords({ body, collection }: { body: unknown; collection: string }) {
  const rows = adminRows(body);
  if (!rows.length) return <Empty>这里暂时没有需要查看的记录。</Empty>;
  const preferred = adminPreferredColumns[collection] ?? [];
  const available = new Set(rows.flatMap((row) => Object.keys(row)));
  const columns = preferred.filter((key) => available.has(key));
  const visibleColumns = columns.length ? columns : Object.keys(rows[0] ?? {}).slice(0, 6);
  const formatValue = (key: string, value: unknown) => adminValue(key, value, collection);

  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead><tr>{visibleColumns.map((key) => <th key={key}>{adminFieldLabels[key] ?? key.replaceAll("_", " ")}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={String(row.id ?? row.user_id ?? row.cache_key ?? rowIndex)}>
              {visibleColumns.map((key) => <td key={key} title={formatValue(key, row[key])}>{formatValue(key, row[key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminPage({
  toast,
  navigate,
  collection = "users",
}: {
  toast: (message: string, error?: boolean) => void;
  navigate: (path: string) => void;
  collection?: string;
}) {
  const [body, setBody] = useState<unknown>(null);
  const [overview, setOverview] = useState<AdminOverview>({});
  const [visibleCollection, setVisibleCollection] = useState(collection);
  const collections = ["users", "credentials", "tasks", "reservations", "invitations", "teams", "team-invitations", "sign-tasks", "signout-tasks", "emails", "audit-logs", "gateway-jobs", "gateway-snapshots"];
  const collectionLabels: Record<string, string> = {
    users: "使用账号",
    credentials: "校园账号连接",
    tasks: "提前预约安排",
    reservations: "全部预约",
    invitations: "预约邀请",
    teams: "同行小队",
    "team-invitations": "小队邀请",
    "sign-tasks": "签到安排",
    "signout-tasks": "签退安排",
    emails: "通知送达",
    "audit-logs": "重要操作",
    "gateway-jobs": "内容获取情况",
    "gateway-snapshots": "可用时间更新",
  };

  async function load(path = `/api/v1/admin/${collection}`, nextCollection = collection) {
    try {
      setBody(await api(path));
      setVisibleCollection(nextCollection);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => {
    setVisibleCollection(collection);
    void Promise.all([
      load(`/api/v1/admin/${collection}`, collection),
      api<AdminOverview>("/api/v1/admin/dashboard").then(setOverview),
    ]);
  }, [collection]);

  return (
    <div className="admin-page">
      <PageIntro title="保持预约服务清晰可用" description="查看账号、预约与通知情况，及时发现需要人工处理的内容。" />
      <section className="admin-overview motion-card" aria-label="使用概览">
        <article><Activity size={19} /><span>正在使用</span><strong>{overview.active_users ?? "-"}</strong><small>个可用账号</small></article>
        <article><Shield size={19} /><span>校园账号</span><strong>{overview.active_credentials ?? "-"}</strong><small>个已连接</small></article>
        <article><CalendarClock size={19} /><span>提前安排</span><strong>{overview.open_tasks ?? "-"}</strong><small>项尚未完成</small></article>
        <article><Send size={19} /><span>待送达通知</span><strong>{overview.pending_emails ?? "-"}</strong><small>封等待发送</small></article>
      </section>
    <Card title={collectionLabels[visibleCollection] ?? "运营记录"} icon={<Database size={20} />}>
      <div className="toolbar admin-toolbar">
        <select value={collection} onChange={(event) => navigate(`/admin/${event.target.value}`)}>
          {collections.map((item) => <option key={item} value={item}>{collectionLabels[item]}</option>)}
        </select>
        <Button type="button" onClick={() => api("/api/v1/admin/emails/test", { method: "POST" }).then(() => toast("确认邮件已发送，请检查收件箱")).catch((error: ApiError) => toast(error.message, true))}>确认邮件可送达</Button>
      </div>
      <AdminRecords body={body} collection={visibleCollection} />
    </Card>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  function navigate(path: string) {
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setRoute(routeFromPath(path));
  }

  function toast(text: string, error = false) {
    setMessage(text);
    setIsError(error);
    window.setTimeout(() => setMessage(""), 3200);
  }

  async function refreshMe() {
    try {
      setSession(await api<Session>("/api/v1/me"));
      if (window.location.pathname === "/" || window.location.pathname === "/index.html") navigate("/rooms");
    } catch {
      setSession(null);
    }
  }

  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onCredentialInvalidated = () => {
      setSession((current) => current ? { ...current, credential: { ...current.credential, credential_status: "REAUTH_REQUIRED" } } : current);
      setRoute(routeFromPath("/credentials"));
    };
    window.addEventListener("credential-invalidated", onCredentialInvalidated);
    return () => window.removeEventListener("credential-invalidated", onCredentialInvalidated);
  }, []);

  useEffect(() => { void refreshMe(); }, []);

  useEffect(() => {
    if (!session) return;
    const needsCredential = session.credential.credential_status !== "ACTIVE" || session.credential.setup_required === true;
    if (needsCredential && window.location.pathname !== "/credentials") {
      window.history.replaceState(null, "", "/credentials");
      setRoute(routeFromPath("/credentials"));
    }
    if (!needsCredential && window.location.pathname === "/credentials") {
      navigate("/rooms");
    }
  }, [session, route]);

  async function logout() {
    await api("/api/v1/auth/logout", { method: "POST" }).catch(() => null);
    setSession(null);
    navigate("/");
  }

  if (!session) return <><AuthPanel onReady={refreshMe} toast={toast} /><Toast message={message} error={isError} /></>;

  if (session.credential.credential_status !== "ACTIVE" || session.credential.setup_required === true) {
    return (
      <>
        <CredentialLockPage session={session} refresh={refreshMe} toast={toast} navigate={navigate} onLogout={logout} />
        <Toast message={message} error={isError} />
      </>
    );
  }

  return (
    <Shell session={session} page={route.page} navigate={navigate} onLogout={logout}>
      <PageStage key={window.location.pathname} page={route.page}>
        {route.page === "rooms" && !route.roomId ? <RoomsPage toast={toast} navigate={navigate} /> : null}
        {route.page === "rooms" && route.roomId ? <RoomDetailPage roomId={route.roomId} session={session} toast={toast} navigate={navigate} /> : null}
        {route.page === "tasks" ? <TasksPage toast={toast} navigate={navigate} mode={route.taskMode ?? "list"} /> : null}
        {route.page === "teams" ? <TeamsPage toast={toast} navigate={navigate} mode={route.teamMode ?? "list"} inviteTeamId={route.teamInviteId} /> : null}
        {route.page === "history" ? <HistoryPage toast={toast} /> : null}
        {route.page === "admin" ? <AdminPage toast={toast} navigate={navigate} collection={route.adminCollection ?? "users"} /> : null}
      </PageStage>
      <footer className="footer">
        <BrandLockup compact />
        <span>清楚查看时间，从容完成预约</span>
      </footer>
      <Toast message={message} error={isError} />
    </Shell>
  );
}
