import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  CircleUserRound,
  ClipboardList,
  DoorOpen,
  History,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  RefreshCw,
  Settings,
  Shield,
  UsersRound,
} from "lucide-react";
import { api, ApiError, type GatewayJob, waitForGatewayJob } from "./api";

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
    DRAFT: "草稿",
    WAITING_WINDOW: "等待窗口",
    WAITING_MEMBERS: "等待成员",
    READY: "准备中",
    ACTIVE: "执行中",
    SUBMITTING: "提交中",
    SUCCESS: "成功",
    FAILED: "失败",
    CANCELLED: "已取消",
    EXPIRED: "已过期",
    PENDING: "待执行",
    DISABLED: "已关闭",
  };
  return labels[value] ?? value;
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
    <section className="card">
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
  state: "available" | "empty" | "selected";
  tooltip: string;
  ariaLabel?: string;
  disabled?: boolean;
};

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
}: {
  data: TrackerBlock[];
  label: string;
  onSelect?: (index: number) => void;
}) {
  const segments = Array.from({ length: Math.ceil(data.length / 4) }, (_, index) => data.slice(index * 4, index * 4 + 4));
  return (
    <div className="uptime-kuma-timeline" role={onSelect ? "group" : "img"} aria-label={label}>
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
                onClick={() => onSelect(index)}
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
                  const state = slotAvailable(ranges, slot) ? "available" : "empty";
                  return {
                    key: `${date}-${slot}`,
                    state,
                    tooltip: `${dayLabel(date)} ${slot}-${end} ${state === "available" ? "可用" : "不可用"}`,
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
  function choose(date: string, index: number) {
    const ranges = room.days[date] ?? [];
    if (room.reservable === false || !slotAvailable(ranges, timeSlots[index] ?? "")) return;

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

    onChange({
      date,
      startIndex,
      endIndex,
      startTime: timeSlots[startIndex] ?? "08:00",
      endTime: minutesToTime(timeToMinutes(timeSlots[endIndex] ?? "08:00") + 30),
    });
  }

  return (
    <div className="square-time-picker">
      <div className="slot-legend" aria-hidden="true">
        <span><i className="legend-available" />可选</span>
        <span><i className="legend-selected" />已选</span>
        <span><i className="legend-disabled" />不可选</span>
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
                data={timeSlots.map((slot, index) => {
                  const available = room.reservable !== false && slotAvailable(room.days[date] ?? [], slot);
                  const selected = selectionContains(selection, date, index);
                  const end = minutesToTime(timeToMinutes(slot) + 30);
                  return {
                    key: `${date}-${slot}`,
                    state: selected ? "selected" : available ? "available" : "empty",
                    tooltip: `${dayLabel(date)} ${slot}-${end} ${selected ? "已选" : available ? "可选" : "不可选"}`,
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
}: {
  participants: ReservationParticipant[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
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
          <small>第一位成员将作为主预约人，需至少有 2 分可用积分</small>
        </div>
        <div className="guest-option-grid">
          {participants.map((participant) => {
            const order = selectedIds.indexOf(participant.id);
            const selected = order >= 0;
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
                  {participant.totalScore == null ? "积分未知" : `剩余 ${participant.totalScore} 分`}
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
    <main className="auth-layout">
      <section className="auth-copy">
        <div className="brand-mark">NJAU Libyy</div>
        <h1>研讨间预约</h1>
        <p>查看未来三天的可用时间，和小队成员一起完成预约、签到与签退。</p>
        <ul className="auth-intro-list">
          <li>按时间快速查找可预约房间</li>
          <li>统一管理小队成员与预约积分</li>
          <li>提前安排预约和签到提醒</li>
        </ul>
      </section>
      <section className="auth-card">
        {tab === "login" ? (
          <>
            <div className="auth-heading">
              <span className="eyebrow">账户登录</span>
              <h2>欢迎回来</h2>
              <p>使用注册邮箱继续管理你的研讨间预约。</p>
            </div>
            <form onSubmit={(event) => submit("/api/v1/auth/login", event, "登录成功")} className="form-stack">
              <Field label="邮箱"><input name="email" type="email" autoComplete="email" required /></Field>
              <Field label="密码"><input name="password" type="password" autoComplete="current-password" required minLength={8} /></Field>
              <Button busy={busy === "/api/v1/auth/login"} type="submit">登录</Button>
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
              <h2>注册账号</h2>
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
    { id: "tasks", label: "自动任务", icon: <ClipboardList size={18} /> },
    { id: "teams", label: "我的小队", icon: <UsersRound size={18} /> },
    { id: "history", label: "预约记录", icon: <History size={18} /> },
    { id: "admin", label: "系统管理", icon: <Shield size={18} />, admin: true },
  ];
  return (
    <div className="app-shell">
      <header className="top-nav">
        <button className="brand-button" onClick={() => navigate("/rooms")}>NJAU Libyy</button>
        <nav className="nav-pills">
          {items.filter((item) => !item.admin || session.user.role === "ADMIN").map((item) => (
            <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => navigate(pagePath(item.id))}>{item.icon}{item.label}</button>
          ))}
        </nav>
        <div className="top-actions">
          <div className="user-chip"><CircleUserRound size={18} /><span>{session.user.realName ?? session.user.email}</span>{session.user.totalScore != null ? <span className={`score-badge${session.user.totalScore >= 4 ? ' full' : session.user.totalScore >= 2 ? ' mid' : ' low'}`}>{session.user.totalScore}</span> : null}</div>
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
          <p>完成连接后，即可查询研讨间、提交预约并使用签到服务。账号信息仅用于访问图书馆预约功能。</p>
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
            toast(error instanceof Error ? error.message : "统一认证启动失败", true);
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
      <Card title="可预约研讨间" icon={<CalendarClock size={20} />}>
        <div className="three-day-head">
          <div>
            <span className="eyebrow">未来三天</span>
            <div className="date-strip">{dates.map((date) => <span key={date}>{dayLabel(date)}</span>)}</div>
            <small className={`cache-status ${cache?.status?.toLowerCase() ?? "miss"}`}>
              {cache?.status === "FRESH" ? "可用时间已更新" : cache?.status === "STALE" ? "当前信息可能不是最新" : cache?.status === "EXPIRED" ? "请更新可用时间" : "正在获取可用时间"}
              {cache?.refreshedAt ? ` · 更新于 ${formatTimestamp(cache.refreshedAt)}` : ""}
            </small>
          </div>
          <Button className="desktop-only-action" onClick={() => loadRooms(true)} busy={busy} type="button"><RefreshCw size={16} />刷新</Button>
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
        {!rooms.length && !busy ? <Empty>未来三天暂时没有可预约的研讨间</Empty> : null}
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
    if (primaryParticipant.totalScore == null || primaryParticipant.totalScore < 2) {
      toast("主预约人剩余积分不足 2 分或暂时无法获取", true);
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
      <Card title="选择预约时间" icon={<DoorOpen size={20} />}>
        {busy ? <Empty>正在获取可预约时间</Empty> : null}
        {!busy && !room ? <Empty>这个研讨间当前不可预约或已下线</Empty> : null}
        {room ? (
          <form className="form-stack" onSubmit={reserve}>
            <div className="room-detail-head">
              <div>
                <span className="eyebrow">房间信息</span>
                <h2>{room.name}</h2>
                <p>{room.roomLocation ?? "研讨室"} · {room.minReservationNum}-{room.maxNum} 人 · {room.reservable === false ? "当前不可预约" : "可预约"}</p>
              </div>
              <Button className="desktop-only-action" onClick={() => loadRoom(true)} busy={busy} type="button" variant="secondary"><RefreshCw size={16} />刷新</Button>
            </div>
            {room.reservable === false ? <div className="room-warning">这个研讨间当前暂停预约，你仍可查看已有时间安排。</div> : null}
            <SquareTimeGridPicker dates={dates} room={room} selection={selection} onChange={setSelection} />
            <OrderedParticipantPicker participants={participants} selectedIds={selectedParticipantIds} onChange={setSelectedParticipantIds} />
            <div className="reservation-summary">
              <div>
                <span className="eyebrow">预约确认</span>
                <strong>{selection ? `${dayLabel(selection.date)} ${selection.startTime}-${selection.endTime}` : "尚未选择时间段"}</strong>
                <small>{primaryParticipant ? `主预约人：${primaryParticipant.realName} · 共 ${selectedParticipantIds.length} 人` : "请选择成员，第一位将作为主预约人"}</small>
                <small className={!primaryParticipant || primaryParticipant.totalScore == null || primaryParticipant.totalScore < 2 ? "score-warning" : ""}>
                  {primaryParticipant ? `主预约人剩余积分：${primaryParticipant.totalScore ?? "未知"}（至少需要 2 分）` : "尚未选择主预约人"}
                </small>
              </div>
              <Button disabled={!selection || !selectedParticipantIds.length || room.reservable === false || !primaryParticipant || primaryParticipant.totalScore == null || primaryParticipant.totalScore < 2} busy={submitting}>提交预约</Button>
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
  const [busy, setBusy] = useState(false);
  const [optionBusy, setOptionBusy] = useState(false);

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
    if (!selectedParticipantIds.length || !roomId) {
      toast("请选择研讨间和预约成员", true);
      return;
    }
    setBusy(true);
    try {
      if (taskType === "reservation") {
        await api("/api/v1/reservation-tasks", {
          method: "POST",
          body: JSON.stringify({
            targetDate: addDays(today(), 3),
            startTime: data.startTime,
            endTime: data.endTime,
            roomId: Number(roomId),
            primaryUserId: selectedParticipantIds[0],
            participantUserIds: selectedParticipantIds,
          }),
        });
      } else {
        const option = reservationOptions.find((item) => item.id === reservationOptionId);
        if (!option) throw new Error("请先查找并选择一条进行中的预约");
        await api("/api/v1/sign-workflows", {
          method: "POST",
          body: JSON.stringify({
            roomId: Number(roomId),
            participantUserIds: selectedParticipantIds,
            anchorUserId: option.ownerUserId,
            officialReservationId: option.officialReservationId,
            signAdvanceMinutes: Number(data.signAdvanceMinutes),
            signoutAdvanceMinutes: Number(data.signoutAdvanceMinutes),
          }),
        });
      }
      toast("自动任务已创建");
      form.reset();
      setSelectedParticipantIds([]);
      setRoomId("");
      setReservationOptions([]);
      setReservationOptionId("");
      await load();
      navigate("/tasks");
    } catch (error) {
      toast(error instanceof Error ? error.message : "创建失败", true);
    } finally {
      setBusy(false);
    }
  }

  async function refreshOptions() {
    if (!roomId || !selectedParticipantIds.length) {
      toast("请先选择研讨间和预约成员", true);
      return;
    }
    setOptionBusy(true);
    try {
      const response = await api<GatewayJob<{ options: ReservationOption[] }> | { options: ReservationOption[] }>("/api/v1/reservation-options/refresh", {
        method: "POST",
        body: JSON.stringify({ roomId: Number(roomId), participantUserIds: selectedParticipantIds }),
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
      toast("任务状态已更新");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", true);
    }
  }

  async function cancelWorkflow(id: string) {
    try {
      await api(`/api/v1/sign-workflows/${id}/cancel`, { method: "POST" });
      toast("任务已取消");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "取消失败", true);
    }
  }

  if (mode === "new") {
    return (
      <div className="compact-page">
        <button className="back-button" type="button" onClick={() => navigate("/tasks")}>
          <ChevronLeft size={18} />返回任务
        </button>
      <Card title="创建自动任务" icon={<ClipboardList size={20} />}>
        <form className="form-grid" onSubmit={create}>
          <Field label="任务类型">
            <select value={taskType} onChange={(event) => { setTaskType(event.target.value as "reservation" | "sign"); setReservationOptions([]); setReservationOptionId(""); }}>
              <option value="reservation">自动预约</option>
              <option value="sign">自动签到与签退</option>
            </select>
          </Field>
          <Field label="房间">
            <select value={roomId} onChange={(event) => { setRoomId(event.target.value); setReservationOptions([]); setReservationOptionId(""); }} required>
              <option value="">请选择研讨间</option>
              {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
            </select>
          </Field>
          {taskType === "reservation" ? (
            <>
              <Field label="预约日期"><input value={addDays(today(), 3)} readOnly /></Field>
              <Field label="开始时间"><input name="startTime" type="time" step="1800" required /></Field>
              <Field label="结束时间"><input name="endTime" type="time" step="1800" required /></Field>
            </>
          ) : (
            <>
              <Field label="提前签到（分钟）"><input name="signAdvanceMinutes" type="number" min="0" max="60" defaultValue="15" required /></Field>
              <Field label="提前签退（分钟）"><input name="signoutAdvanceMinutes" type="number" min="0" max="60" defaultValue="10" required /></Field>
            </>
          )}
          <div className="form-grid-wide">
            <OrderedParticipantPicker participants={participants} selectedIds={selectedParticipantIds} onChange={(ids) => { setSelectedParticipantIds(ids); setReservationOptions([]); setReservationOptionId(""); }} />
          </div>
          {taskType === "sign" ? (
            <div className="form-grid-wide reservation-option-panel">
              <div className="toolbar">
                <Button type="button" variant="secondary" busy={optionBusy} onClick={() => void refreshOptions()}><RefreshCw size={16} />查找可管理的预约</Button>
              </div>
              <Field label="已有预约">
                <select value={reservationOptionId} onChange={(event) => setReservationOptionId(event.target.value)} required>
                  <option value="">请先查找预约</option>
                  {reservationOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.ownerName} · {option.roomName} · {option.date} {option.startTime}-{option.endTime}</option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}
          <Button busy={busy}>创建任务</Button>
        </form>
      </Card>
      </div>
    );
  }

  return (
    <div className="compact-page">
      <Card title="自动任务" icon={<History size={20} />}>
        <div className="toolbar page-toolbar">
          <Button type="button" onClick={() => navigate("/tasks/new")}><ClipboardList size={16} />创建任务</Button>
          <Button className="desktop-only-action" type="button" variant="secondary" onClick={load}><RefreshCw size={16} />刷新</Button>
        </div>
        <div className="task-sections">
          <section className="task-section">
            <div className="section-subtitle"><strong>自动预约</strong><span>{tasks.length} 项</span></div>
            <div className="list">
              {tasks.map((task) => (
                <article className="list-row" key={String(task.id)}>
                  <div><strong>{String(task.target_date)} {String(task.start_time)}-{String(task.end_time)}</strong><span>{statusText(task.status as string | number | null | undefined)} · {taskCandidateText(task)}</span></div>
                  <div className="row-actions">
                    {["DRAFT", "WAITING_WINDOW", "WAITING_MEMBERS", "READY"].includes(String(task.status)) ? <Button variant="ghost" onClick={() => action(String(task.id), "cancel")}>取消</Button> : null}
                  </div>
                </article>
              ))}
              {!tasks.length ? <Empty>还没有自动预约任务，可为三天后的预约提前做好安排</Empty> : null}
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
              {!workflows.length ? <Empty>还没有签到或签退安排</Empty> : null}
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
  const [teamScores, setTeamScores] = useState<Record<string, Array<{ userId: string; realName: string; totalScore: number | null }>>>({});

  async function load(refreshScores = false) {
    try {
      const [teamData, invitable] = await Promise.all([
        api<{ teams: Team[]; invitations?: TeamInvitation[] }>("/api/v1/teams/mine"),
        api<InvitableUser[]>("/api/v1/users/invitable").catch(() => []),
      ]);
      setTeams(teamData.teams);
      setInvitations(teamData.invitations ?? []);
      setUsers(invitable);
      const scores: Record<string, Array<{ userId: string; realName: string; totalScore: number | null }>> = {};
      for (const team of teamData.teams) {
        if (team.is_leader !== true && team.is_leader !== 1) continue;
        try {
          if (refreshScores) {
            const job = await api<GatewayJob>(`/api/v1/teams/${encodeURIComponent(team.id)}/member-scores`, { method: "POST" });
            await waitForGatewayJob(job);
          }
          const result = await api<{ members: Array<{ userId: string; realName: string; totalScore: number | null }> }>(`/api/v1/teams/${encodeURIComponent(team.id)}/member-scores`);
          scores[team.id] = result.members;
        } catch { scores[team.id] = []; }
      }
      setTeamScores(scores);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, []);

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

  const leaderTeams = teams.filter(isTeamLeader);
  const canCreateTeam = leaderTeams.length === 0;

  if (mode === "new") {
    if (!canCreateTeam && teams.length) {
      return (
        <div className="compact-page">
          <button className="back-button" type="button" onClick={() => navigate("/teams")}>
            <ChevronLeft size={18} />返回小队
          </button>
          <Card title="创建小队" icon={<UsersRound size={20} />}>
            <Empty>你已经创建了一个小队。如需与其他同学协作，可以加入他们的小队。</Empty>
          </Card>
        </div>
      );
    }
    return (
      <div className="compact-page">
        <button className="back-button" type="button" onClick={() => navigate("/teams")}>
          <ChevronLeft size={18} />返回小队
        </button>
      <Card title="创建小队" icon={<UsersRound size={20} />}>
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
          <ChevronLeft size={18} />返回小队
        </button>
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
      <Card title="我的小队" icon={<Mail size={20} />}>
        <div className="toolbar page-toolbar">
          <Button type="button" disabled={!canCreateTeam} onClick={() => navigate("/teams/new")}><UsersRound size={16} />{canCreateTeam ? "新建小队" : "已创建小队"}</Button>
          <Button className="desktop-only-action" type="button" variant="secondary" onClick={() => load(true)}><RefreshCw size={16} />刷新</Button>
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
                    const memberScore = teamScores[team.id]?.find((s) => s.realName === member.name);
                    const scoreText = memberScore?.totalScore != null ? ` · ${memberScore.totalScore}分` : "";
                    return (
                      <span key={`${team.id}-${member.id}`} className={member.role === "队长" ? "leader" : ""}>
                        {member.name}<small>{member.role}{scoreText}</small>
                      </span>
                    );
                  })}
                </div>
              </div>
              {isTeamLeader(team) ? (
                <Button type="button" variant="secondary" onClick={() => navigate(`/teams/${encodeURIComponent(team.id)}/invite`)}>邀请成员</Button>
              ) : null}
            </article>
          ))}
          {!teams.length ? <Empty>你还没有加入小队，可创建小队并邀请同学一起预约</Empty> : null}
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
      toast("预约状态已更新");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", true);
    }
  }

  return (
    <Card title="预约记录" icon={<History size={20} />}>
      <div className="toolbar desktop-only-toolbar"><Button type="button" onClick={() => load(true)}><RefreshCw size={16} />更新记录</Button></div>
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
        {!items.length ? <Empty>还没有预约记录，完成预约后可在这里查看和管理</Empty> : null}
      </div>
      {items.length > pageSize ? (
        <div className="pagination">
          <Button type="button" variant="secondary" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button>
          <span>{currentPage} / {totalPages}</span>
          <Button type="button" variant="secondary" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</Button>
        </div>
      ) : null}
    </Card>
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
  const collections = ["users", "credentials", "tasks", "reservations", "teams", "team-invitations", "sign-tasks", "signout-tasks", "emails", "audit-logs", "gateway-jobs", "gateway-snapshots"];
  const collectionLabels: Record<string, string> = {
    users: "用户账号",
    credentials: "校园账号连接",
    tasks: "自动预约任务",
    reservations: "预约记录",
    teams: "小队",
    "team-invitations": "小队邀请",
    "sign-tasks": "签到任务",
    "signout-tasks": "签退任务",
    emails: "邮件通知",
    "audit-logs": "操作记录",
    "gateway-jobs": "访问任务",
    "gateway-snapshots": "数据记录",
  };

  async function load(path = `/api/v1/admin/${collection}`) {
    try {
      setBody(await api(path));
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, [collection]);

  return (
    <Card title="系统管理" icon={<Settings size={20} />}>
      <div className="admin-intro">
        <strong>{collectionLabels[collection] ?? "系统记录"}</strong>
        <span>查看服务运行情况和用户操作记录。</span>
      </div>
      <div className="toolbar admin-toolbar">
        <select value={collection} onChange={(event) => navigate(`/admin/${event.target.value}`)}>
          {collections.map((item) => <option key={item} value={item}>{collectionLabels[item]}</option>)}
        </select>
        <Button type="button" variant="secondary" onClick={() => load("/api/v1/admin/config")}>运行设置</Button>
        <Button type="button" onClick={() => api("/api/v1/admin/emails/test", { method: "POST" }).then(() => toast("测试邮件已发送")).catch((error: ApiError) => toast(error.message, true))}>发送测试邮件</Button>
      </div>
      <pre className="json-panel" aria-label={`${collectionLabels[collection] ?? "系统"}详情`}>{JSON.stringify(body, null, 2)}</pre>
    </Card>
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
      <main className="content">
        {route.page === "rooms" && !route.roomId ? <RoomsPage toast={toast} navigate={navigate} /> : null}
        {route.page === "rooms" && route.roomId ? <RoomDetailPage roomId={route.roomId} session={session} toast={toast} navigate={navigate} /> : null}
        {route.page === "tasks" ? <TasksPage toast={toast} navigate={navigate} mode={route.taskMode ?? "list"} /> : null}
        {route.page === "teams" ? <TeamsPage toast={toast} navigate={navigate} mode={route.teamMode ?? "list"} inviteTeamId={route.teamInviteId} /> : null}
        {route.page === "history" ? <HistoryPage toast={toast} /> : null}
        {route.page === "admin" ? <AdminPage toast={toast} navigate={navigate} collection={route.adminCollection ?? "users"} /> : null}
      </main>
      <footer className="footer">
        <strong>NJAU Libyy</strong>
        <span>研讨间预约与小队协作</span>
      </footer>
      <Toast message={message} error={isError} />
    </Shell>
  );
}
