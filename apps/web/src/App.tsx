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
import { api, ApiError } from "./api";

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
type SignAutomationTask = {
  id: string;
  reservation_id: string;
  scheduled_at: number;
  status: string;
  attempt_count?: number;
  executed_at?: number | null;
  official_reservation_id?: string | null;
  room_name_snapshot?: string | null;
  date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
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
type RecentContact = {
  id: string;
  studentId?: string;
  student_id?: string;
  realName?: string;
  real_name?: string;
  lastUsedAt?: number;
  last_used_at?: number;
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

function contactName(contact: RecentContact): string {
  return contact.realName ?? contact.real_name ?? contact.studentId ?? contact.student_id ?? contact.id;
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
const availabilityTicks = [8, 12, 16, 20, 22];
type TrackerBlock = {
  key: string;
  state: "available" | "empty";
  tooltip: string;
};

function slotAvailable(ranges: AvailabilityRange[], slot: string): boolean {
  const start = timeToMinutes(slot);
  const end = start + 30;
  return ranges.some((range) => start >= timeToMinutes(range.startTime) && end <= timeToMinutes(range.endTime));
}

function TremorTracker({ data, label }: { data: TrackerBlock[]; label: string }) {
  return (
    <div className="tremor-tracker" role="img" aria-label={label}>
      {data.map((block) => (
        <div className="tremor-tracker-block-shell" key={block.key} title={block.tooltip}>
          <div className={`tremor-tracker-block ${block.state}`} />
        </div>
      ))}
    </div>
  );
}

function RoomAvailabilityHistory({ dates, room }: { dates: string[]; room: RoomWithDays }) {
  return (
    <div className="availability-history" aria-label={`${room.name} 三天可用时间状态`}>
      <div className="availability-ticks" aria-hidden="true">
        {availabilityTicks.map((hour) => <span key={hour}>{String(hour).padStart(2, "0")}</span>)}
      </div>
      <div className="availability-rows">
        {dates.map((date) => {
          const ranges = room.days[date] ?? [];
          return (
            <div className="availability-row" key={`${room.id}-${date}`}>
              <span className="availability-day">{dayLabel(date)}</span>
              <TremorTracker
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
            <div className="slot-hour-line">
              {timeSlots.map((slot, index) => (
                <span key={`head-${slot}`} className={index % 2 === 0 ? "full-hour" : "half-hour"}>
                  {index % 2 === 0 ? slot : ""}
                </span>
              ))}
            </div>
          </div>
          {dates.map((date) => (
            <div className="slot-day-row" key={date} role="row">
              <div className="slot-day-label">
                <strong>{dayLabel(date)}</strong>
                <small>{rangeText(room.days[date] ?? [])}</small>
              </div>
              <div className="slot-cells">
                {timeSlots.map((slot, index) => {
                  const available = room.reservable !== false && slotAvailable(room.days[date] ?? [], slot);
                  const selected = selectionContains(selection, date, index);
                  return (
                    <button
                      type="button"
                      key={`${date}-${slot}`}
                      className={`slot-cell ${available ? "available" : "disabled"} ${selected ? "selected" : ""}`}
                      disabled={!available}
                      onClick={() => choose(date, index)}
                      aria-pressed={selected}
                      aria-label={`${dayLabel(date)} ${slot} 到 ${minutesToTime(timeToMinutes(slot) + 30)}`}
                    >
                      <span className="sr-only">{slot}</span>
                    </button>
                  );
                })}
              </div>
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

function ReservationGuestsPicker({
  teamMembers,
  contacts,
  selectedTeamMemberIds,
  selectedContactIds,
  contactQuery,
  contactBusy,
  onToggleTeamMember,
  onToggleContact,
  onContactQueryChange,
  onSearchContact,
}: {
  teamMembers: TeamMember[];
  contacts: RecentContact[];
  selectedTeamMemberIds: string[];
  selectedContactIds: string[];
  contactQuery: string;
  contactBusy: boolean;
  onToggleTeamMember: (id: string) => void;
  onToggleContact: (id: string) => void;
  onContactQueryChange: (value: string) => void;
  onSearchContact: () => Promise<void>;
}) {
  return (
    <section className="guest-picker" aria-label="邀请同行成员">
      <div className="guest-picker-head">
        <div>
          <span className="eyebrow">Guests</span>
          <h3>邀请同行成员</h3>
        </div>
        <span>{selectedTeamMemberIds.length + selectedContactIds.length} 人</span>
      </div>
      <div className="guest-section">
        <div className="guest-section-title">
          <strong>小队成员</strong>
          <small>仅展示你作为队长的小队成员</small>
        </div>
        <div className="guest-option-grid">
          {teamMembers.map((member) => (
            <label className="guest-option" key={member.id}>
              <input
                type="checkbox"
                checked={selectedTeamMemberIds.includes(member.id)}
                onChange={() => onToggleTeamMember(member.id)}
              />
              <span>
                <strong>{memberName(member)}</strong>
                <small>{member.teamName ?? "小队成员"}</small>
              </span>
            </label>
          ))}
          {!teamMembers.length ? <div className="guest-empty">暂无可直接邀请的小队成员</div> : null}
        </div>
      </div>
      <div className="guest-section">
        <div className="guest-section-title">
          <strong>最近联系人</strong>
          <small>输入准确学号查询后会加入最近联系人</small>
        </div>
        <div className="contact-search-row">
          <input
            value={contactQuery}
            onChange={(event) => onContactQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onSearchContact();
              }
            }}
            placeholder="输入学号添加联系人"
            inputMode="numeric"
          />
          <Button type="button" variant="secondary" busy={contactBusy} onClick={() => void onSearchContact()}>添加</Button>
        </div>
        <div className="guest-option-grid">
          {contacts.map((contact) => (
            <label className="guest-option" key={contact.id}>
              <input
                type="checkbox"
                checked={selectedContactIds.includes(contact.id)}
                onChange={() => onToggleContact(contact.id)}
              />
              <span>
                <strong>{contactName(contact)}</strong>
                <small>{contact.studentId ?? contact.student_id ?? "最近联系人"}</small>
              </span>
            </label>
          ))}
          {!contacts.length ? <div className="guest-empty">还没有最近联系人</div> : null}
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
      toast(result.devCode ? `验证码已发送：${result.devCode}` : "验证码邮件已排队");
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
        <h1>研讨室预约工作台</h1>
        <div className="product-fragment auth-grid-preview compact">
          <div className="fragment-bar">
            <span />
            <span />
            <span />
            <strong>可用时间</strong>
          </div>
          <div className="preview-calendar-grid" aria-hidden="true">
            {Array.from({ length: 42 }, (_, index) => (
              <span
                key={index}
                className={
                  [4, 5, 6, 17, 18, 29].includes(index) ? "selected"
                  : [0, 1, 2, 12, 13, 14, 20, 21, 30, 31, 32, 33, 34].includes(index) ? "available"
                  : ""
                }
              />
            ))}
          </div>
        </div>
      </section>
      <section className="auth-card">
        {tab === "login" ? (
          <>
            <div className="auth-heading">
              <span className="eyebrow">Sign in</span>
              <h2>登录到工作台</h2>
              <p>使用邮箱和密码进入研讨室预约管理界面。</p>
            </div>
            <form onSubmit={(event) => submit("/api/v1/auth/login", event, "登录成功")} className="form-stack">
              <Field label="邮箱"><input name="email" type="email" autoComplete="email" required /></Field>
              <Field label="密码"><input name="password" type="password" autoComplete="current-password" required minLength={8} /></Field>
              <Button busy={busy === "/api/v1/auth/login"} type="submit">进入工作台</Button>
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
    { id: "rooms", label: "房间", icon: <DoorOpen size={18} /> },
    { id: "tasks", label: "任务", icon: <ClipboardList size={18} /> },
    { id: "teams", label: "小队", icon: <UsersRound size={18} /> },
    { id: "history", label: "历史", icon: <History size={18} /> },
    { id: "admin", label: "管理", icon: <Shield size={18} />, admin: true },
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
          <div className="user-chip"><CircleUserRound size={18} /><span>{session.user.realName ?? session.user.email}</span></div>
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
          <span className="status-pill">{session.credential.credential_status}</span>
          <h1>连接校园统一认证</h1>
          <p>保存学号和统一认证密码后，服务端会在隔离的浏览器环境中登录图书馆系统，并在官方会话失效时自动恢复。</p>
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
            toast("已启动统一认证");
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
          <Button busy={busy}>保存并登录图书馆系统</Button>
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

  async function loadRooms() {
    setBusy(true);
    try {
      const response = await api<RoomsResponse>("/api/v1/rooms");
      const normalized = normalizeRooms(response, fallbackDates);
      setDates(normalized.dates);
      setRooms(normalized.rooms.filter((room) => room.reservable !== false));
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void loadRooms(); }, []);

  return (
    <div className="room-list-page">
      <Card title="研讨间列表" icon={<CalendarClock size={20} />}>
        <div className="three-day-head">
          <div>
            <span className="eyebrow">三天可用日期</span>
            <div className="date-strip">{dates.map((date) => <span key={date}>{dayLabel(date)}</span>)}</div>
          </div>
          <Button className="desktop-only-action" onClick={loadRooms} busy={busy} type="button"><RefreshCw size={16} />刷新</Button>
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
        {!rooms.length && !busy ? <Empty>暂无可展示房间</Empty> : null}
      </Card>
    </div>
  );
}

function RoomDetailPage({
  roomId,
  toast,
  navigate,
}: {
  roomId: number;
  toast: (message: string, error?: boolean) => void;
  navigate: (path: string) => void;
}) {
  const fallbackDates = useMemo(() => threeDayDates(), []);
  const [dates, setDates] = useState<string[]>(fallbackDates);
  const [room, setRoom] = useState<RoomWithDays | null>(null);
  const [selection, setSelection] = useState<TimeSelection | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [contacts, setContacts] = useState<RecentContact[]>([]);
  const [selectedTeamMemberIds, setSelectedTeamMemberIds] = useState<string[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [contactQuery, setContactQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [contactBusy, setContactBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const teamMemberOptions = useMemo(() => {
    const members = new Map<string, TeamMember>();
    for (const team of teams) {
      if (team.is_leader !== true && team.is_leader !== 1) continue;
      for (const member of parseTeamMembers(team.members)) {
        if (!members.has(member.id)) members.set(member.id, { ...member, teamName: team.name });
      }
    }
    return [...members.values()];
  }, [teams]);

  async function loadRoom() {
    setBusy(true);
    try {
      const [response, teamData, contactData] = await Promise.all([
        api<RoomsResponse>("/api/v1/rooms"),
        api<{ teams: Team[] }>("/api/v1/teams/mine").catch(() => ({ teams: [] })),
        api<RecentContact[]>("/api/v1/recent-contacts").catch(() => []),
      ]);
      const normalized = normalizeRooms(response, fallbackDates);
      const availableRooms = normalized.rooms.filter((item) => item.reservable !== false);
      setDates(normalized.dates);
      setRoom(availableRooms.find((item) => item.id === roomId) ?? null);
      setTeams(teamData.teams);
      setContacts(contactData);
      setSelection(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void loadRoom(); }, [roomId]);

  async function searchContact() {
    const query = contactQuery.trim();
    if (!query) return;
    setContactBusy(true);
    try {
      const found = await api<RecentContact>(`/api/v1/official-users/search?q=${encodeURIComponent(query)}`);
      const latest = await api<RecentContact[]>("/api/v1/recent-contacts");
      setContacts(latest);
      setSelectedContactIds((current) => current.includes(found.id) ? current : [...current, found.id]);
      setContactQuery("");
      toast(`已添加 ${contactName(found)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "联系人查询失败", true);
    } finally {
      setContactBusy(false);
    }
  }

  async function reserve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!room || !selection || room.reservable === false) return;
    setSubmitting(true);
    try {
      await api("/api/v1/reservations/manual", {
        method: "POST",
        body: JSON.stringify({
          date: selection.date,
          roomId: room.id,
          startTime: selection.startTime,
          endTime: selection.endTime,
          teamMemberUserIds: selectedTeamMemberIds,
          contactIds: selectedContactIds,
        }),
      });
      toast("预约已提交");
      setSelection(null);
      setSelectedTeamMemberIds([]);
      setSelectedContactIds([]);
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
      <Card title="预约时间选择" icon={<DoorOpen size={20} />}>
        {busy ? <Empty>正在加载房间时间线</Empty> : null}
        {!busy && !room ? <Empty>没有找到这个房间</Empty> : null}
        {room ? (
          <form className="form-stack" onSubmit={reserve}>
            <div className="room-detail-head">
              <div>
                <span className="eyebrow">Room</span>
                <h2>{room.name}</h2>
                <p>{room.roomLocation ?? "研讨室"} · {room.minReservationNum}-{room.maxNum} 人 · {room.reservable === false ? "当前不可预约" : "可预约"}</p>
              </div>
              <Button className="desktop-only-action" onClick={loadRoom} busy={busy} type="button" variant="secondary"><RefreshCw size={16} />刷新</Button>
            </div>
            {room.reservable === false ? <div className="room-warning">该房间当前由官方标记为不可预约，时间线仅用于查看状态。</div> : null}
            <SquareTimeGridPicker dates={dates} room={room} selection={selection} onChange={setSelection} />
            <ReservationGuestsPicker
              teamMembers={teamMemberOptions}
              contacts={contacts}
              selectedTeamMemberIds={selectedTeamMemberIds}
              selectedContactIds={selectedContactIds}
              contactQuery={contactQuery}
              contactBusy={contactBusy}
              onToggleTeamMember={(id) => setSelectedTeamMemberIds((current) => toggleValue(current, id))}
              onToggleContact={(id) => setSelectedContactIds((current) => toggleValue(current, id))}
              onContactQueryChange={setContactQuery}
              onSearchContact={searchContact}
            />
            <div className="reservation-summary">
              <div>
                <span className="eyebrow">Selected</span>
                <strong>{selection ? `${dayLabel(selection.date)} ${selection.startTime}-${selection.endTime}` : "尚未选择时间段"}</strong>
                <small>主预约人 + {selectedTeamMemberIds.length + selectedContactIds.length} 位同行成员</small>
              </div>
              <Button disabled={!selection || room.reservable === false} busy={submitting}>提交预约</Button>
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
  const [signTasks, setSignTasks] = useState<SignAutomationTask[]>([]);
  const [signoutTasks, setSignoutTasks] = useState<SignAutomationTask[]>([]);

  async function load() {
    try {
      const [reservationTasks, signInTasks, signOutTasks] = await Promise.all([
        api<Task[]>("/api/v1/reservation-tasks"),
        api<SignAutomationTask[]>("/api/v1/sign-tasks").catch(() => []),
        api<SignAutomationTask[]>("/api/v1/signout-tasks").catch(() => []),
      ]);
      setTasks(reservationTasks);
      setSignTasks(signInTasks);
      setSignoutTasks(signOutTasks);
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
      await api("/api/v1/reservation-tasks", {
        method: "POST",
        body: JSON.stringify({
          targetDate: data.targetDate,
          startTime: data.startTime,
          endTime: data.endTime,
          candidateRooms: [{ roomId: Number(data.roomId), roomName: data.roomName }],
          teamMemberUserIds: [],
        }),
      });
      toast("自动任务已创建");
      form.reset();
      await load();
      navigate("/tasks");
    } catch (error) {
      toast(error instanceof Error ? error.message : "创建失败", true);
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

  if (mode === "new") {
    return (
      <div className="compact-page">
        <button className="back-button" type="button" onClick={() => navigate("/tasks")}>
          <ChevronLeft size={18} />返回任务
        </button>
      <Card title="自动预约" icon={<ClipboardList size={20} />}>
        <form className="form-grid" onSubmit={create}>
          <Field label="日期"><input name="targetDate" type="date" required /></Field>
          <Field label="开始"><input name="startTime" type="time" step="1800" required /></Field>
          <Field label="结束"><input name="endTime" type="time" step="1800" required /></Field>
          <Field label="房间 ID"><input name="roomId" inputMode="numeric" required /></Field>
          <Field label="房间名"><input name="roomName" required /></Field>
          <Button>创建草稿</Button>
        </form>
      </Card>
      </div>
    );
  }

  return (
    <div className="compact-page">
      <Card title="任务列表" icon={<History size={20} />}>
        <div className="toolbar page-toolbar">
          <Button type="button" onClick={() => navigate("/tasks/new")}><ClipboardList size={16} />新建任务</Button>
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
                    {task.status === "DRAFT" ? <Button variant="secondary" onClick={() => action(String(task.id), "enable")}>启用</Button> : null}
                    {["DRAFT", "WAITING_WINDOW", "WAITING_MEMBERS", "READY"].includes(String(task.status)) ? <Button variant="ghost" onClick={() => action(String(task.id), "cancel")}>取消</Button> : null}
                  </div>
                </article>
              ))}
              {!tasks.length ? <Empty>暂无自动预约任务</Empty> : null}
            </div>
          </section>
          <section className="task-section">
            <div className="section-subtitle"><strong>自动签到与签退</strong><span>{signTasks.length + signoutTasks.length} 项</span></div>
            <div className="list">
              {[
                ...signTasks.map((task) => ({ ...task, kind: "自动签到" })),
                ...signoutTasks.map((task) => ({ ...task, kind: "自动签退" })),
              ].sort((left, right) => Number(right.scheduled_at ?? 0) - Number(left.scheduled_at ?? 0)).map((task) => (
                <article className="list-row" key={`${task.kind}-${task.id}`}>
                  <div>
                    <strong>{task.kind} · {task.room_name_snapshot ?? "研讨间"} · {task.date ?? "日期待定"} {task.start_time ?? ""}-{task.end_time ?? ""}</strong>
                    <span>{statusText(task.status)} · 计划 {formatTimestamp(task.scheduled_at)} · 执行 {formatTimestamp(task.executed_at)} · 尝试 {Number(task.attempt_count ?? 0)} 次</span>
                  </div>
                </article>
              ))}
              {!signTasks.length && !signoutTasks.length ? <Empty>暂无自动签到或签退任务</Empty> : null}
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

  async function load() {
    try {
      const [teamData, invitable] = await Promise.all([
        api<{ teams: Team[]; invitations?: TeamInvitation[] }>("/api/v1/teams/mine"),
        api<InvitableUser[]>("/api/v1/users/invitable").catch(() => []),
      ]);
      setTeams(teamData.teams);
      setInvitations(teamData.invitations ?? []);
      setUsers(invitable);
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
      toast("邀请邮件已排队");
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
          <Card title="小队" icon={<UsersRound size={20} />}>
            <Empty>你已经创建过小队。每个账号只能创建一个小队，但可以加入多个其他小队。</Empty>
          </Card>
        </div>
      );
    }
    return (
      <div className="compact-page">
        <button className="back-button" type="button" onClick={() => navigate("/teams")}>
          <ChevronLeft size={18} />返回小队
        </button>
      <Card title="小队" icon={<UsersRound size={20} />}>
        <form className="form-stack" onSubmit={create}>
          <Field label="名称"><input name="name" required maxLength={50} /></Field>
          <Field label="描述"><input name="description" maxLength={120} /></Field>
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
        <Card title={team ? `邀请加入 ${team.name}` : "邀请成员"} icon={<Mail size={20} />}>
          {!team ? <Empty>未找到这个小队</Empty> : null}
          {team && !isTeamLeader(team) ? <Empty>只有小队创建者可以邀请成员。</Empty> : null}
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
              {!inviteUsers.length ? <Empty>暂无可邀请的站内用户</Empty> : null}
            </div>
          ) : null}
        </Card>
      </div>
    );
  }

  const pendingInvitations = invitations.filter((invitation) => invitation.status === "PENDING");

  return (
    <div className="compact-page">
      <Card title="成员邀请" icon={<Mail size={20} />}>
        <div className="toolbar page-toolbar">
          <Button type="button" disabled={!canCreateTeam} onClick={() => navigate("/teams/new")}><UsersRound size={16} />{canCreateTeam ? "新建小队" : "已创建小队"}</Button>
          <Button className="desktop-only-action" type="button" variant="secondary" onClick={load}><RefreshCw size={16} />刷新</Button>
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
                <span>{team.description || "无描述"} · {visibleTeamMembers(team).length} 人 · {isTeamLeader(team) ? "我创建的" : "已加入"}</span>
                <div className="team-member-strip">
                  {visibleTeamMembers(team).map((member) => (
                    <span key={`${team.id}-${member.id}`} className={member.role === "队长" ? "leader" : ""}>
                      {member.name}<small>{member.role}</small>
                    </span>
                  ))}
                </div>
              </div>
              {isTeamLeader(team) ? (
                <Button type="button" variant="secondary" onClick={() => navigate(`/teams/${encodeURIComponent(team.id)}/invite`)}>邀请成员</Button>
              ) : null}
            </article>
          ))}
          {!teams.length ? <Empty>暂无小队</Empty> : null}
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
      setItems(await api<Reservation[]>(sync ? "/api/v1/reservations/sync" : "/api/v1/reservations/history", sync ? { method: "POST" } : {}));
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
      const result = await api<{ url?: string }>(`/api/v1/reservations/${id}/${actionName}`, { method: "POST" });
      if (result.url) window.open(result.url, "_blank", "noopener,noreferrer");
      toast("订单状态已更新");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", true);
    }
  }

  return (
    <Card title="预约历史" icon={<History size={20} />}>
      <div className="toolbar desktop-only-toolbar"><Button type="button" onClick={() => load(true)}><RefreshCw size={16} />同步</Button></div>
      <div className="list">
        {visibleItems.map((item) => (
          <article className="list-row" key={String(item.id)}>
            <div>
              <strong>{item.room_name_snapshot} · {item.date} {item.start_time}-{item.end_time}</strong>
              <span>{String(item.statusLabel ?? item.status_label ?? item.status)} · 官方订单 {String(item.official_reservation_id ?? "同步中")}</span>
            </div>
            <div className="row-actions">
              {item.status === "SIGNED_IN" ? <Button variant="secondary" onClick={() => action(String(item.id), "signout")}>签退</Button> : null}
              {item.canCancel || item.can_cancel ? <Button variant="ghost" onClick={() => action(String(item.id), "cancel")}>取消</Button> : null}
            </div>
          </article>
        ))}
        {!items.length ? <Empty>暂无预约记录</Empty> : null}
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
  const collections = ["users", "credentials", "tasks", "reservations", "teams", "team-invitations", "sign-tasks", "signout-tasks", "emails", "audit-logs"];

  async function load(path = `/api/v1/admin/${collection}`) {
    try {
      setBody(await api(path));
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, [collection]);

  return (
    <Card title="管理员" icon={<Settings size={20} />}>
      <div className="toolbar">
        <select value={collection} onChange={(event) => navigate(`/admin/${event.target.value}`)}>
          {collections.map((item) => <option key={item}>{item}</option>)}
        </select>
        <Button type="button" variant="secondary" onClick={() => load("/api/v1/admin/config")}>配置</Button>
        <Button type="button" onClick={() => api("/api/v1/admin/emails/test", { method: "POST" }).then(() => toast("测试邮件已排队")).catch((error: ApiError) => toast(error.message, true))}>测试邮件</Button>
      </div>
      <pre className="json-panel">{JSON.stringify(body, null, 2)}</pre>
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
        {route.page === "rooms" && route.roomId ? <RoomDetailPage roomId={route.roomId} toast={toast} navigate={navigate} /> : null}
        {route.page === "tasks" ? <TasksPage toast={toast} navigate={navigate} mode={route.taskMode ?? "list"} /> : null}
        {route.page === "teams" ? <TeamsPage toast={toast} navigate={navigate} mode={route.teamMode ?? "list"} inviteTeamId={route.teamInviteId} /> : null}
        {route.page === "history" ? <HistoryPage toast={toast} /> : null}
        {route.page === "admin" ? <AdminPage toast={toast} navigate={navigate} collection={route.adminCollection ?? "users"} /> : null}
      </main>
      <footer className="footer">
        <strong>NJAU Libyy</strong>
        <a href="https://github.com/leecyang" target="_blank" rel="noreferrer">github.com/leecyang</a>
      </footer>
      <Toast message={message} error={isError} />
    </Shell>
  );
}
