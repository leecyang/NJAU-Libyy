import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  CheckCircle2,
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

type Page = "rooms" | "tasks" | "teams" | "history" | "sign" | "admin";
type Route = {
  page: Page;
  roomId?: number;
  taskMode?: "list" | "new";
  teamMode?: "list" | "new";
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
type Team = {
  id: string;
  name: string;
  description?: string;
  members?: Array<{ id: string; email: string; real_name?: string; student_id?: string }>;
};
type InvitableUser = {
  id: string;
  email: string;
  real_name?: string;
  student_id?: string;
};
type QueueRow = Record<string, unknown> & { type: string };

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
  sign: "/sign",
  admin: "/admin",
};

function pagePath(page: Page): string {
  return pagePaths[page];
}

function routeFromPath(pathname: string): Route {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const roomMatch = normalized.match(/^\/rooms\/(\d+)$/);
  const adminMatch = normalized.match(/^\/admin\/([a-z-]+)$/);
  if (roomMatch) return { page: "rooms", roomId: Number(roomMatch[1]) };
  if (normalized === "/tasks/new") return { page: "tasks", taskMode: "new" };
  if (normalized === "/tasks") return { page: "tasks" };
  if (normalized === "/teams/new") return { page: "teams", teamMode: "new" };
  if (normalized === "/teams") return { page: "teams" };
  if (normalized === "/history") return { page: "history" };
  if (normalized === "/sign") return { page: "sign" };
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
const hourStarts = Array.from({ length: 14 }, (_, index) => 8 + index);

function slotAvailable(ranges: AvailabilityRange[], slot: string): boolean {
  const start = timeToMinutes(slot);
  const end = start + 30;
  return ranges.some((range) => start >= timeToMinutes(range.startTime) && end <= timeToMinutes(range.endTime));
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
    if (!slotAvailable(ranges, timeSlots[index] ?? "")) return;

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
                  const available = slotAvailable(room.days[date] ?? [], slot);
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
        <p>同源前端、容器后端和校园网 VPN 出口已经合并到一个部署形态。</p>
        <div className="product-fragment room-status-preview">
          <div className="fragment-bar">
            <span />
            <span />
            <span />
            <strong>今日房间状态</strong>
          </div>
          <div className="status-board">
            {[
              { room: "7E08", time: "09:00-11:00", status: "待签到", tone: "warning" },
              { room: "7E10", time: "10:00-12:00", status: "可预约", tone: "success" },
              { room: "8A03", time: "14:00-16:00", status: "已占用", tone: "muted" },
              { room: "9B12", time: "16:30-18:30", status: "可预约", tone: "success" },
            ].map((item) => (
              <div className="status-row" key={`${item.room}-${item.time}`}>
                <div>
                  <strong>{item.room}</strong>
                  <span>{item.time}</span>
                </div>
                <small className={item.tone}>{item.status}</small>
              </div>
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
    { id: "sign", label: "签到", icon: <CheckCircle2 size={18} /> },
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
        <div className="user-chip"><CircleUserRound size={18} /><span>{session.user.realName ?? session.user.email}</span></div>
        <button className="icon-button" onClick={onLogout} aria-label="退出登录"><LogOut size={18} /></button>
      </header>
      {children}
    </div>
  );
}

function SetupCard({ session, refresh, toast }: { session: Session; refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  if (session.credential.credential_status === "ACTIVE") return null;
  return (
    <Card title="官方凭证" icon={<KeyRound size={20} />}>
      <form className="inline-form" onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api("/api/v1/credentials/bind", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
          toast("官方身份绑定成功");
          await refresh();
          event.currentTarget.reset();
        } catch (error) {
          toast(error instanceof Error ? error.message : "绑定失败", true);
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="reflushToken"><textarea name="reflushToken" required rows={3} /></Field>
        <Button busy={busy}>绑定</Button>
      </form>
    </Card>
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
      setRooms(normalized.rooms);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void loadRooms(); }, []);

  return (
    <div className="room-list-page">
      <Card title="房间时间片" icon={<CalendarClock size={20} />}>
        <div className="three-day-head">
          <div>
            <span className="eyebrow">三天可用日期</span>
            <div className="date-strip">{dates.map((date) => <span key={date}>{dayLabel(date)}</span>)}</div>
          </div>
          <Button onClick={loadRooms} busy={busy} type="button"><RefreshCw size={16} />刷新</Button>
        </div>
        <div className="room-grid">
          {rooms.map((room) => (
            <button
              key={room.id}
              className="room-card"
              onClick={() => navigate(`/rooms/${room.id}`)}
            >
              <div className="room-card-main">
                <strong>{room.name}</strong>
                <span>{room.roomLocation ?? "研讨室"} · {room.minReservationNum}-{room.maxNum} 人</span>
              </div>
              <div className="room-day-ranges">
                {dates.map((date) => (
                  <div className="room-day-range" key={`${room.id}-${date}`}>
                    <b>{dayLabel(date)}</b>
                    <small>{rangeText(room.days[date] ?? [])}</small>
                  </div>
                ))}
              </div>
              <span className="room-card-action">进入时间选择</span>
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
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function loadRoom() {
    setBusy(true);
    try {
      const response = await api<RoomsResponse>("/api/v1/rooms");
      const normalized = normalizeRooms(response, fallbackDates);
      setDates(normalized.dates);
      setRoom(normalized.rooms.find((item) => item.id === roomId) ?? null);
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
    if (!room || !selection) return;
    setSubmitting(true);
    try {
      await api("/api/v1/reservations/manual", {
        method: "POST",
        body: JSON.stringify({
          date: selection.date,
          roomId: room.id,
          startTime: selection.startTime,
          endTime: selection.endTime,
          teamMemberUserIds: [],
          contactIds: [],
        }),
      });
      toast("预约已提交");
      setSelection(null);
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
                <p>{room.roomLocation ?? "研讨室"} · {room.minReservationNum}-{room.maxNum} 人</p>
              </div>
              <Button onClick={loadRoom} busy={busy} type="button" variant="secondary"><RefreshCw size={16} />刷新</Button>
            </div>
            <SquareTimeGridPicker dates={dates} room={room} selection={selection} onChange={setSelection} />
            <div className="reservation-summary">
              <div>
                <span className="eyebrow">Selected</span>
                <strong>{selection ? `${dayLabel(selection.date)} ${selection.startTime}-${selection.endTime}` : "尚未选择时间段"}</strong>
              </div>
              <Button disabled={!selection} busy={submitting}>提交预约</Button>
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

  async function load() {
    try {
      setTasks(await api<Task[]>("/api/v1/reservation-tasks"));
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = formData(event.currentTarget);
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
      event.currentTarget.reset();
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
          <Button type="button" variant="secondary" onClick={load}><RefreshCw size={16} />刷新</Button>
        </div>
        <div className="list">
          {tasks.map((task) => (
            <article className="list-row" key={String(task.id)}>
              <div><strong>{task.target_date} {task.start_time}-{task.end_time}</strong><span>{task.status}</span></div>
              <div className="row-actions">
                {task.status === "DRAFT" ? <Button variant="secondary" onClick={() => action(String(task.id), "enable")}>启用</Button> : null}
                {["DRAFT", "WAITING_WINDOW", "WAITING_MEMBERS", "READY"].includes(String(task.status)) ? <Button variant="ghost" onClick={() => action(String(task.id), "cancel")}>取消</Button> : null}
              </div>
            </article>
          ))}
          {!tasks.length ? <Empty>暂无自动预约任务</Empty> : null}
        </div>
      </Card>
    </div>
  );
}

function TeamsPage({
  toast,
  navigate,
  mode = "list",
}: {
  toast: (message: string, error?: boolean) => void;
  navigate: (path: string) => void;
  mode?: "list" | "new";
}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<InvitableUser[]>([]);

  async function load() {
    try {
      const [teamData, invitable] = await Promise.all([
        api<{ teams: Team[] }>("/api/v1/teams/mine"),
        api<InvitableUser[]>("/api/v1/users/invitable").catch(() => []),
      ]);
      setTeams(teamData.teams);
      setUsers(invitable);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await api("/api/v1/teams", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
      toast("小队已创建");
      event.currentTarget.reset();
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

  if (mode === "new") {
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

  return (
    <div className="compact-page">
      <Card title="成员邀请" icon={<Mail size={20} />}>
        <div className="toolbar page-toolbar">
          <Button type="button" onClick={() => navigate("/teams/new")}><UsersRound size={16} />新建小队</Button>
          <Button type="button" variant="secondary" onClick={load}><RefreshCw size={16} />刷新</Button>
        </div>
        <div className="list">
          {teams.map((team) => (
            <article className="list-row" key={team.id}>
              <div><strong>{team.name}</strong><span>{team.description || "无描述"}</span></div>
              <select onChange={(event) => event.target.value && invite(team.id, event.target.value)} defaultValue="">
                <option value="">邀请成员</option>
                {users.map((user) => <option key={user.id} value={user.id}>{user.real_name ?? user.email}</option>)}
              </select>
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

  async function load(sync = false) {
    try {
      setItems(await api<Reservation[]>(sync ? "/api/v1/reservations/sync" : "/api/v1/reservations/history", sync ? { method: "POST" } : {}));
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, []);

  async function action(id: string, actionName: "cancel" | "sign-link" | "signout") {
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
      <div className="toolbar"><Button type="button" onClick={() => load(true)}><RefreshCw size={16} />同步</Button></div>
      <div className="list">
        {items.map((item) => (
          <article className="list-row" key={String(item.id)}>
            <div>
              <strong>{item.room_name_snapshot} · {item.date} {item.start_time}-{item.end_time}</strong>
              <span>{String(item.statusLabel ?? item.status_label ?? item.status)} · 官方订单 {String(item.official_reservation_id ?? "同步中")}</span>
            </div>
            <div className="row-actions">
              {item.status === "SCHEDULED" ? <Button variant="secondary" onClick={() => action(String(item.id), "sign-link")}>签到入口</Button> : null}
              {item.status === "SIGNED_IN" ? <Button variant="secondary" onClick={() => action(String(item.id), "signout")}>签退</Button> : null}
              {item.canCancel || item.can_cancel ? <Button variant="ghost" onClick={() => action(String(item.id), "cancel")}>取消</Button> : null}
            </div>
          </article>
        ))}
        {!items.length ? <Empty>暂无预约记录</Empty> : null}
      </div>
    </Card>
  );
}

function SignPage({ toast }: { toast: (message: string, error?: boolean) => void }) {
  const [signs, setSigns] = useState<Record<string, unknown>[]>([]);
  const [signouts, setSignouts] = useState<Record<string, unknown>[]>([]);

  async function load() {
    try {
      const [signData, signoutData] = await Promise.all([
        api<Record<string, unknown>[]>("/api/v1/sign-tasks"),
        api<Record<string, unknown>[]>("/api/v1/signout-tasks"),
      ]);
      setSigns(signData);
      setSignouts(signoutData);
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    }
  }
  useEffect(() => { void load(); }, []);

  const rows = useMemo<QueueRow[]>(
    () => [...signs.map((row) => ({ ...row, type: "签到" })), ...signouts.map((row) => ({ ...row, type: "签退" }))],
    [signs, signouts],
  );
  return (
    <Card title="签到队列" icon={<CheckCircle2 size={20} />}>
      <div className="toolbar"><Button type="button" onClick={load}><RefreshCw size={16} />刷新</Button></div>
      <div className="list">
        {rows.map((row) => (
          <article className="list-row" key={`${row.type}-${String(row.id)}`}>
            <div><strong>{String(row.type)} · {String(row.reservation_id)}</strong><span>{String(row.status)} · 尝试 {String(row.attempt_count ?? 0)} 次</span></div>
            <small>{row.scheduled_at ? new Date(Number(row.scheduled_at)).toLocaleString() : ""}</small>
          </article>
        ))}
        {!rows.length ? <Empty>暂无队列记录</Empty> : null}
      </div>
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

  useEffect(() => { void refreshMe(); }, []);

  async function logout() {
    await api("/api/v1/auth/logout", { method: "POST" }).catch(() => null);
    setSession(null);
    navigate("/");
  }

  if (!session) return <><AuthPanel onReady={refreshMe} toast={toast} /><Toast message={message} error={isError} /></>;

  const pageTitle =
    route.page === "rooms" && route.roomId ? "选择预约时间"
    : route.page === "tasks" && route.taskMode === "new" ? "新建自动任务"
    : route.page === "teams" && route.teamMode === "new" ? "创建小队"
    : session.user.studentId ? "预约工作台" : "账号配置";

  return (
    <Shell session={session} page={route.page} navigate={navigate} onLogout={logout}>
      <main className="content">
        <div className="page-head">
          <div><span className="eyebrow">Workspace</span><h1>{pageTitle}</h1></div>
          <div className="status-pill">{session.credential.credential_status}</div>
        </div>
        <SetupCard session={session} refresh={refreshMe} toast={toast} />
        {route.page === "rooms" && !route.roomId ? <RoomsPage toast={toast} navigate={navigate} /> : null}
        {route.page === "rooms" && route.roomId ? <RoomDetailPage roomId={route.roomId} toast={toast} navigate={navigate} /> : null}
        {route.page === "tasks" ? <TasksPage toast={toast} navigate={navigate} mode={route.taskMode ?? "list"} /> : null}
        {route.page === "teams" ? <TeamsPage toast={toast} navigate={navigate} mode={route.teamMode ?? "list"} /> : null}
        {route.page === "history" ? <HistoryPage toast={toast} /> : null}
        {route.page === "sign" ? <SignPage toast={toast} /> : null}
        {route.page === "admin" ? <AdminPage toast={toast} navigate={navigate} collection={route.adminCollection ?? "users"} /> : null}
      </main>
      <footer className="footer"><strong>NJAU Libyy</strong><span>Docker Compose · Tailscale · SQLite</span></footer>
      <Toast message={message} error={isError} />
    </Shell>
  );
}
