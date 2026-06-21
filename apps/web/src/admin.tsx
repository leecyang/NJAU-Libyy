import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  CalendarClock,
  CheckCircle2,
  Database,
  FileClock,
  Gauge,
  KeyRound,
  Mail,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Shield,
  UserCheck,
  UsersRound,
  XCircle,
} from "lucide-react";
import { api, ApiError } from "./api";

type AdminCollection =
  | "overview"
  | "users"
  | "credentials"
  | "tasks"
  | "reservations"
  | "invitations"
  | "teams"
  | "team-invitations"
  | "sign-tasks"
  | "signout-tasks"
  | "emails"
  | "audit-logs"
  | "gateway-jobs"
  | "gateway-snapshots"
  | "config";

type AdminRow = Record<string, unknown>;
type AdminListResponse = {
  items: AdminRow[];
  total: number;
  page: number;
  pageSize: number;
  summary?: Record<string, number>;
};
type AdminDashboard = Record<string, unknown> & {
  generatedAt?: number;
  exceptions?: Record<string, unknown>;
  recentFailures?: AdminRow[];
  config?: Record<string, unknown>;
};
type Column = {
  key: string;
  label: string;
  className?: string;
  render?: (row: AdminRow) => ReactNode;
};
type CollectionConfig = {
  id: AdminCollection;
  label: string;
  description: string;
  icon: ReactNode;
  endpoint?: string;
  searchPlaceholder?: string;
  statuses?: string[];
  columns: Column[];
  rowTitle: (row: AdminRow) => string;
  rowMeta: (row: AdminRow) => string;
  actions?: (row: AdminRow) => AdminAction[];
};
type AdminAction = {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  confirm: string;
  run: () => Promise<unknown>;
};

const pageSizeOptions = [10, 25, 50, 100];
const terminalTaskStatuses = new Set(["SUCCESS", "FAILED", "CANCELLED", "EXPIRED"]);

const collectionAliases: Record<string, AdminCollection> = {
  sign: "sign-tasks",
  signout: "signout-tasks",
  mail: "emails",
  audit: "audit-logs",
  dashboard: "overview",
};

function canonicalCollection(value?: string): AdminCollection {
  if (!value) return "overview";
  const normalized = collectionAliases[value] ?? value;
  return collections.some((item) => item.id === normalized) ? normalized as AdminCollection : "overview";
}

function asText(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function asNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatTimestamp(value: unknown): string {
  const timestamp = typeof value === "string" ? Number(value) : value;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(timestamp));
}

function formatDate(value: unknown): string {
  return asText(value);
}

function statusLabel(value: unknown): string {
  const raw = asText(value, "UNKNOWN");
  const labels: Record<string, string> = {
    ACTIVE: "正常",
    BANNED: "已封禁",
    DELETED: "已注销",
    ADMIN: "管理员",
    USER: "用户",
    PENDING: "待处理",
    SENT: "已发送",
    FAILED: "失败",
    SUCCESS: "成功",
    CANCELLED: "已取消",
    EXPIRED: "已过期",
    QUEUED: "排队中",
    RUNNING: "执行中",
    READY: "已准备",
    WAITING_WINDOW: "等待开放",
    WAITING_MEMBERS: "等待成员",
    SUBMITTING: "提交中",
    DRAFT: "草稿",
    REAUTH_REQUIRED: "需重绑",
    REFRESH_FAILED: "刷新失败",
    REFRESHING: "刷新中",
    DISABLED: "已停用",
    SIGNED_IN: "已签到",
    SIGNED_OUT: "已签退",
  };
  return labels[raw] ?? raw;
}

function statusTone(value: unknown): string {
  const raw = asText(value, "UNKNOWN");
  if (["ACTIVE", "SUCCESS", "SENT", "SIGNED_IN", "SIGNED_OUT", "FRESH"].includes(raw)) return "good";
  if (["PENDING", "QUEUED", "RUNNING", "READY", "WAITING_WINDOW", "WAITING_MEMBERS", "REFRESHING", "STALE"].includes(raw)) return "warn";
  if (["FAILED", "BANNED", "REAUTH_REQUIRED", "REFRESH_FAILED", "DISABLED", "EXPIRED"].includes(raw)) return "bad";
  if (["CANCELLED", "DELETED"].includes(raw)) return "muted";
  return "neutral";
}

function StatusBadge({ value }: { value: unknown }) {
  return <span className={`admin-status ${statusTone(value)}`}>{statusLabel(value)}</span>;
}

function ValueCell({ value }: { value: unknown }) {
  return <span>{asText(value)}</span>;
}

function TimeCell({ value }: { value: unknown }) {
  return <span>{formatTimestamp(value)}</span>;
}

function IdCell({ value }: { value: unknown }) {
  return <code className="admin-id">{asText(value)}</code>;
}

function MetricCard({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: string; tone?: string }) {
  return (
    <article className={`admin-metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

function JsonPreview({ value }: { value: unknown }) {
  if (typeof value !== "string") return <span>—</span>;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const keys = Object.keys(parsed).slice(0, 3);
    return <span>{keys.length ? keys.map((key) => `${key}: ${asText(parsed[key])}`).join(" · ") : "空对象"}</span>;
  } catch {
    return <span>{value}</span>;
  }
}

function makeUserActions(row: AdminRow): AdminAction[] {
  const id = asText(row.id, "");
  const status = asText(row.status, "");
  const actions: AdminAction[] = [];
  if (id && status === "ACTIVE") {
    actions.push({
      label: "封禁",
      danger: true,
      icon: <Ban size={14} />,
      confirm: `确认封禁账号 ${asText(row.email)}？这会撤销会话、停用凭证并取消未完成自动任务。`,
      run: () => api(`/api/v1/admin/users/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status: "BANNED" }) }),
    });
  }
  if (id && status === "BANNED") {
    actions.push({
      label: "解封",
      icon: <UserCheck size={14} />,
      confirm: `确认解封账号 ${asText(row.email)}？`,
      run: () => api(`/api/v1/admin/users/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }) }),
    });
  }
  if (id && asText(row.credential_status, "") && asText(row.credential_status) !== "DISABLED") {
    actions.push({
      label: "要求重绑",
      icon: <KeyRound size={14} />,
      confirm: `确认要求 ${asText(row.email)} 重新绑定校园账号？`,
      run: () => api(`/api/v1/admin/users/${encodeURIComponent(id)}/require-rebind`, { method: "POST" }),
    });
  }
  return actions;
}

function makeTaskActions(row: AdminRow): AdminAction[] {
  const id = asText(row.id, "");
  const status = asText(row.status, "");
  if (!id || terminalTaskStatuses.has(status) || status === "SUBMITTING") return [];
  return [{
    label: "取消任务",
    danger: true,
    icon: <XCircle size={14} />,
    confirm: `确认取消自动预约任务 ${id}？`,
    run: () => api(`/api/v1/admin/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  }];
}

function makeEmailActions(row: AdminRow): AdminAction[] {
  const id = asText(row.id, "");
  const status = asText(row.status, "");
  const lockUntil = asNumber(row.delivery_lock_until);
  if (!id || (status !== "FAILED" && !(status === "PENDING" && lockUntil > 0 && lockUntil < Date.now()))) return [];
  return [{
    label: "重试",
    icon: <RotateCcw size={14} />,
    confirm: `确认重新投递邮件 ${id}？`,
    run: () => api(`/api/v1/admin/emails/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  }];
}

function makeGatewayActions(row: AdminRow): AdminAction[] {
  const id = asText(row.id, "");
  const status = asText(row.status, "");
  const lane = asText(row.lane, "");
  if (!id) return [];
  const actions: AdminAction[] = [];
  if (status === "QUEUED") {
    actions.push({
      label: "取消",
      danger: true,
      icon: <XCircle size={14} />,
      confirm: `确认取消官方网关任务 ${id}？`,
      run: () => api(`/api/v1/admin/gateway-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    });
  }
  if (status === "FAILED" && lane === "READ") {
    actions.push({
      label: "重试",
      icon: <RotateCcw size={14} />,
      confirm: `确认重试只读官方网关任务 ${id}？`,
      run: () => api(`/api/v1/admin/gateway-jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
    });
  }
  return actions;
}

const collections: CollectionConfig[] = [
  { id: "overview", label: "概览", description: "运营指标、异常摘要与系统状态。", icon: <Gauge size={17} />, columns: [], rowTitle: () => "", rowMeta: () => "" },
  {
    id: "users",
    label: "用户",
    description: "账号、绑定状态、任务量和封禁管理。",
    icon: <UsersRound size={17} />,
    endpoint: "/api/v1/admin/users",
    searchPlaceholder: "搜索邮箱、学号、姓名或用户 ID",
    statuses: ["ACTIVE", "BANNED", "DELETED"],
    columns: [
      { key: "email", label: "账号", render: (row) => <><strong>{asText(row.real_name, asText(row.email))}</strong><span>{asText(row.email)}</span></> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "credential_status", label: "凭证", render: (row) => row.credential_status ? <StatusBadge value={row.credential_status} /> : "未绑定" },
      { key: "student_id", label: "学号", render: (row) => <ValueCell value={row.student_id} /> },
      { key: "task_count", label: "任务", className: "number", render: (row) => <ValueCell value={row.task_count} /> },
      { key: "reservation_count", label: "预约", className: "number", render: (row) => <ValueCell value={row.reservation_count} /> },
      { key: "last_login_at", label: "最近登录", render: (row) => <TimeCell value={row.last_login_at} /> },
    ],
    rowTitle: (row) => asText(row.real_name, asText(row.email)),
    rowMeta: (row) => `${asText(row.email)} · ${asText(row.student_id, "未绑定学号")}`,
    actions: makeUserActions,
  },
  {
    id: "credentials",
    label: "凭证",
    description: "校园账号绑定、刷新状态和脱敏错误信息。",
    icon: <KeyRound size={17} />,
    endpoint: "/api/v1/admin/credentials",
    searchPlaceholder: "搜索邮箱、姓名、学号、错误码",
    statuses: ["ACTIVE", "REFRESHING", "REFRESH_FAILED", "REAUTH_REQUIRED", "DISABLED"],
    columns: [
      { key: "email", label: "用户", render: (row) => <><strong>{asText(row.real_name, asText(row.email))}</strong><span>{asText(row.email)}</span></> },
      { key: "credential_status", label: "状态", render: (row) => <StatusBadge value={row.credential_status} /> },
      { key: "last_refresh_success_at", label: "最近成功", render: (row) => <TimeCell value={row.last_refresh_success_at} /> },
      { key: "refresh_failure_count", label: "失败次数", className: "number", render: (row) => <ValueCell value={row.refresh_failure_count} /> },
      { key: "last_error_code", label: "错误码", render: (row) => <ValueCell value={row.last_error_code} /> },
      { key: "updated_at", label: "更新时间", render: (row) => <TimeCell value={row.updated_at} /> },
    ],
    rowTitle: (row) => asText(row.real_name, asText(row.email)),
    rowMeta: (row) => `${statusLabel(row.credential_status)} · ${asText(row.last_error_code, "无错误")}`,
    actions: (row) => makeUserActions({ ...row, id: row.user_id, status: row.user_status }),
  },
  {
    id: "tasks",
    label: "自动任务",
    description: "自动预约任务状态、候选房间和失败原因。",
    icon: <CalendarClock size={17} />,
    endpoint: "/api/v1/admin/tasks",
    searchPlaceholder: "搜索任务、用户、预约编号、错误码",
    statuses: ["DRAFT", "WAITING_WINDOW", "WAITING_MEMBERS", "READY", "SUBMITTING", "SUCCESS", "FAILED", "CANCELLED", "EXPIRED"],
    columns: [
      { key: "id", label: "任务", render: (row) => <IdCell value={row.id} /> },
      { key: "owner_email", label: "用户", render: (row) => <><strong>{asText(row.owner_name, asText(row.owner_email))}</strong><span>{asText(row.owner_email)}</span></> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "target_date", label: "预约时间", render: (row) => `${formatDate(row.target_date)} ${asText(row.start_time)}-${asText(row.end_time)}` },
      { key: "candidate_rooms", label: "候选房间", render: (row) => <ValueCell value={row.candidate_rooms} /> },
      { key: "failure_code", label: "异常", render: (row) => <ValueCell value={row.failure_code} /> },
      { key: "created_at", label: "创建", render: (row) => <TimeCell value={row.created_at} /> },
    ],
    rowTitle: (row) => `${formatDate(row.target_date)} ${asText(row.start_time)}-${asText(row.end_time)}`,
    rowMeta: (row) => `${asText(row.owner_name, asText(row.owner_email))} · ${statusLabel(row.status)}`,
    actions: makeTaskActions,
  },
  {
    id: "reservations",
    label: "预约",
    description: "全部预约记录与官方同步状态。",
    icon: <FileClock size={17} />,
    endpoint: "/api/v1/admin/reservations",
    searchPlaceholder: "搜索预约、房间、用户、官方编号",
    statuses: ["RESERVED", "SIGNED_IN", "SIGNED_OUT", "CANCELLED", "FAILED", "SUCCESS"],
    columns: [
      { key: "official_reservation_id", label: "官方编号", render: (row) => <ValueCell value={row.official_reservation_id} /> },
      { key: "room_name_snapshot", label: "房间", render: (row) => <strong>{asText(row.room_name_snapshot)}</strong> },
      { key: "owner_email", label: "用户", render: (row) => <ValueCell value={row.owner_name ?? row.owner_email} /> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "date", label: "时间", render: (row) => `${formatDate(row.date)} ${asText(row.start_time)}-${asText(row.end_time)}` },
      { key: "submission_type", label: "来源", render: (row) => <ValueCell value={row.submission_type} /> },
      { key: "created_at", label: "创建", render: (row) => <TimeCell value={row.created_at} /> },
    ],
    rowTitle: (row) => asText(row.room_name_snapshot),
    rowMeta: (row) => `${formatDate(row.date)} ${asText(row.start_time)}-${asText(row.end_time)} · ${statusLabel(row.status)}`,
  },
  {
    id: "invitations",
    label: "预约邀请",
    description: "多人预约邀请状态与响应来源。",
    icon: <Mail size={17} />,
    endpoint: "/api/v1/admin/invitations",
    searchPlaceholder: "搜索邀请、任务、邀请人、被邀请人",
    statuses: ["PENDING", "AUTO_APPROVED", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED", "USED"],
    columns: [
      { key: "invitee_real_name", label: "被邀请人", render: (row) => <><strong>{asText(row.invitee_real_name)}</strong><span>{asText(row.invitee_student_id)}</span></> },
      { key: "inviter_email", label: "邀请人", render: (row) => <ValueCell value={row.inviter_email} /> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "approval_source", label: "来源", render: (row) => <ValueCell value={row.approval_source} /> },
      { key: "expires_at", label: "过期", render: (row) => <TimeCell value={row.expires_at} /> },
      { key: "created_at", label: "创建", render: (row) => <TimeCell value={row.created_at} /> },
    ],
    rowTitle: (row) => asText(row.invitee_real_name),
    rowMeta: (row) => `${asText(row.inviter_email)} · ${statusLabel(row.status)}`,
  },
  {
    id: "teams",
    label: "小队",
    description: "同行小队、队长和成员规模。",
    icon: <UsersRound size={17} />,
    endpoint: "/api/v1/admin/teams",
    searchPlaceholder: "搜索小队、队长、说明",
    columns: [
      { key: "name", label: "小队", render: (row) => <><strong>{asText(row.name)}</strong><span>{asText(row.description, "无说明")}</span></> },
      { key: "leader_name", label: "队长", render: (row) => <ValueCell value={row.leader_name ?? row.leader_email} /> },
      { key: "member_count", label: "人数", className: "number", render: (row) => <ValueCell value={row.member_count} /> },
      { key: "created_at", label: "创建", render: (row) => <TimeCell value={row.created_at} /> },
    ],
    rowTitle: (row) => asText(row.name),
    rowMeta: (row) => `${asText(row.leader_name, asText(row.leader_email))} · ${asText(row.member_count)} 人`,
  },
  {
    id: "team-invitations",
    label: "小队邀请",
    description: "小队邀请发送、过期和响应状态。",
    icon: <Mail size={17} />,
    endpoint: "/api/v1/admin/team-invitations",
    searchPlaceholder: "搜索小队、邀请人、被邀请人",
    statuses: ["PENDING", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
    columns: [
      { key: "team_name", label: "小队", render: (row) => <strong>{asText(row.team_name)}</strong> },
      { key: "inviter_email", label: "邀请人", render: (row) => <ValueCell value={row.inviter_email} /> },
      { key: "invitee_email", label: "被邀请人", render: (row) => <ValueCell value={row.invitee_email} /> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "expires_at", label: "过期", render: (row) => <TimeCell value={row.expires_at} /> },
      { key: "created_at", label: "创建", render: (row) => <TimeCell value={row.created_at} /> },
    ],
    rowTitle: (row) => asText(row.team_name),
    rowMeta: (row) => `${asText(row.invitee_email)} · ${statusLabel(row.status)}`,
  },
  {
    id: "sign-tasks",
    label: "签到",
    description: "签到任务参数接入、执行和失败状态。",
    icon: <CheckCircle2 size={17} />,
    endpoint: "/api/v1/admin/sign-tasks",
    searchPlaceholder: "搜索签到任务、预约、房间、用户",
    statuses: ["WAITING_PARAMETERS", "READY", "DISABLED", "SUCCESS", "FAILED"],
    columns: [
      { key: "id", label: "任务", render: (row) => <IdCell value={row.id} /> },
      { key: "room_name_snapshot", label: "房间", render: (row) => <strong>{asText(row.room_name_snapshot)}</strong> },
      { key: "owner_email", label: "用户", render: (row) => <ValueCell value={row.owner_email} /> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "scheduled_at", label: "计划执行", render: (row) => <TimeCell value={row.scheduled_at} /> },
      { key: "attempt_count", label: "尝试", className: "number", render: (row) => <ValueCell value={row.attempt_count} /> },
    ],
    rowTitle: (row) => asText(row.room_name_snapshot),
    rowMeta: (row) => `${formatDate(row.date)} ${asText(row.start_time)}-${asText(row.end_time)} · ${statusLabel(row.status)}`,
  },
  {
    id: "signout-tasks",
    label: "签退",
    description: "签退任务排程、执行和异常状态。",
    icon: <CheckCircle2 size={17} />,
    endpoint: "/api/v1/admin/signout-tasks",
    searchPlaceholder: "搜索签退任务、预约、房间、用户",
    statuses: ["PENDING", "SUBMITTING", "SUCCESS", "FAILED", "DISABLED"],
    columns: [
      { key: "id", label: "任务", render: (row) => <IdCell value={row.id} /> },
      { key: "room_name_snapshot", label: "房间", render: (row) => <strong>{asText(row.room_name_snapshot)}</strong> },
      { key: "owner_email", label: "用户", render: (row) => <ValueCell value={row.owner_email} /> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "scheduled_at", label: "计划执行", render: (row) => <TimeCell value={row.scheduled_at} /> },
      { key: "attempt_count", label: "尝试", className: "number", render: (row) => <ValueCell value={row.attempt_count} /> },
    ],
    rowTitle: (row) => asText(row.room_name_snapshot),
    rowMeta: (row) => `${formatDate(row.date)} ${asText(row.start_time)}-${asText(row.end_time)} · ${statusLabel(row.status)}`,
  },
  {
    id: "emails",
    label: "邮件",
    description: "邮件 outbox、投递失败和重试。",
    icon: <Mail size={17} />,
    endpoint: "/api/v1/admin/emails",
    searchPlaceholder: "搜索收件人、模板、错误信息",
    statuses: ["PENDING", "SENT", "FAILED"],
    columns: [
      { key: "recipient_email", label: "收件人", render: (row) => <strong>{asText(row.recipient_email)}</strong> },
      { key: "template", label: "模板", render: (row) => <ValueCell value={row.template} /> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "attempt_count", label: "尝试", className: "number", render: (row) => <ValueCell value={row.attempt_count} /> },
      { key: "last_error_message", label: "错误", render: (row) => <ValueCell value={row.last_error_message} /> },
      { key: "created_at", label: "创建", render: (row) => <TimeCell value={row.created_at} /> },
    ],
    rowTitle: (row) => asText(row.recipient_email),
    rowMeta: (row) => `${asText(row.template)} · ${statusLabel(row.status)}`,
    actions: makeEmailActions,
  },
  {
    id: "audit-logs",
    label: "审计",
    description: "用户、系统和管理员高风险操作记录。",
    icon: <Shield size={17} />,
    endpoint: "/api/v1/admin/audit-logs",
    searchPlaceholder: "搜索动作、对象、结果、操作者",
    statuses: ["SUCCESS", "FAILED", "PENDING"],
    columns: [
      { key: "action", label: "动作", render: (row) => <strong>{asText(row.action)}</strong> },
      { key: "actor_type", label: "操作者", render: (row) => <ValueCell value={row.actor_type} /> },
      { key: "target_type", label: "对象", render: (row) => `${asText(row.target_type)} · ${asText(row.target_id)}` },
      { key: "result", label: "结果", render: (row) => <StatusBadge value={row.result} /> },
      { key: "metadata_redacted_json", label: "摘要", render: (row) => <JsonPreview value={row.metadata_redacted_json} /> },
      { key: "created_at", label: "时间", render: (row) => <TimeCell value={row.created_at} /> },
    ],
    rowTitle: (row) => asText(row.action),
    rowMeta: (row) => `${asText(row.actor_type)} · ${asText(row.target_type)} · ${statusLabel(row.result)}`,
  },
  {
    id: "gateway-jobs",
    label: "网关任务",
    description: "官方访问网关队列、失败和只读任务重试。",
    icon: <Activity size={17} />,
    endpoint: "/api/v1/admin/gateway-jobs",
    searchPlaceholder: "搜索任务、类型、lane、错误码",
    statuses: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"],
    columns: [
      { key: "id", label: "任务", render: (row) => <IdCell value={row.id} /> },
      { key: "kind", label: "类型", render: (row) => <strong>{asText(row.kind)}</strong> },
      { key: "lane", label: "通道", render: (row) => <ValueCell value={row.lane} /> },
      { key: "status", label: "状态", render: (row) => <StatusBadge value={row.status} /> },
      { key: "attempt_count", label: "尝试", className: "number", render: (row) => `${asText(row.attempt_count)}/${asText(row.max_attempts)}` },
      { key: "error_code", label: "异常", render: (row) => <ValueCell value={row.error_code} /> },
      { key: "created_at", label: "创建", render: (row) => <TimeCell value={row.created_at} /> },
    ],
    rowTitle: (row) => asText(row.kind),
    rowMeta: (row) => `${asText(row.lane)} · ${statusLabel(row.status)} · ${asText(row.error_code, "无异常")}`,
    actions: makeGatewayActions,
  },
  {
    id: "gateway-snapshots",
    label: "网关缓存",
    description: "官方数据缓存新鲜度、错误和刷新任务关联。",
    icon: <Database size={17} />,
    endpoint: "/api/v1/admin/gateway-snapshots",
    searchPlaceholder: "搜索缓存 key、类型、用户、错误码",
    columns: [
      { key: "cache_key", label: "缓存", render: (row) => <IdCell value={row.cache_key} /> },
      { key: "kind", label: "类型", render: (row) => <strong>{asText(row.kind)}</strong> },
      { key: "scope", label: "范围", render: (row) => <ValueCell value={row.scope} /> },
      { key: "owner_email", label: "用户", render: (row) => <ValueCell value={row.owner_email} /> },
      { key: "refreshed_at", label: "刷新", render: (row) => <TimeCell value={row.refreshed_at} /> },
      { key: "last_error_code", label: "异常", render: (row) => <ValueCell value={row.last_error_code} /> },
      { key: "updated_at", label: "更新", render: (row) => <TimeCell value={row.updated_at} /> },
    ],
    rowTitle: (row) => asText(row.kind),
    rowMeta: (row) => `${asText(row.scope)} · ${formatTimestamp(row.refreshed_at)}`,
  },
  { id: "config", label: "配置", description: "系统配置、特性开关和健康状态。", icon: <Settings size={17} />, columns: [], rowTitle: () => "", rowMeta: () => "" },
];

function configFor(collection: AdminCollection): CollectionConfig {
  return collections.find((item) => item.id === collection) ?? collections[0]!;
}

function DashboardPanel({ data }: { data: AdminDashboard | null }) {
  const accounts = data?.accounts as Record<string, unknown> | undefined;
  const credentials = data?.credentials as Record<string, unknown> | undefined;
  const tasks = data?.tasks as Record<string, unknown> | undefined;
  const mail = data?.mail as Record<string, unknown> | undefined;
  const gateway = data?.gateway as Record<string, unknown> | undefined;
  const exceptions = data?.exceptions as Record<string, unknown> | undefined;
  const config = data?.config as Record<string, unknown> | undefined;
  const failures = Array.isArray(data?.recentFailures) ? data.recentFailures : [];
  return (
    <div className="admin-overview">
      <div className="admin-metrics">
        <MetricCard label="活跃账号" value={asNumber(accounts?.active)} detail={`${asNumber(accounts?.admins)} 个管理员`} />
        <MetricCard label="有效凭证" value={asNumber(credentials?.active)} detail={`${asNumber(credentials?.problem)} 个需处理`} tone={asNumber(credentials?.problem) ? "warn" : ""} />
        <MetricCard label="开放任务" value={asNumber(tasks?.open)} detail={`${asNumber(tasks?.failed)} 个失败`} tone={asNumber(tasks?.failed) ? "bad" : ""} />
        <MetricCard label="待发邮件" value={asNumber(mail?.pending)} detail={`${asNumber(mail?.failed)} 个失败`} tone={asNumber(mail?.failed) ? "bad" : ""} />
        <MetricCard label="网关队列" value={asNumber(gateway?.queued) + asNumber(gateway?.running)} detail={`${asNumber(gateway?.failed)} 个失败`} tone={asNumber(gateway?.failed) ? "bad" : ""} />
        <MetricCard label="异常总数" value={asNumber(exceptions?.total)} detail="任务、凭证、邮件、网关与签到" tone={asNumber(exceptions?.total) ? "bad" : ""} />
      </div>
      <section className="admin-panel">
        <div className="admin-section-head">
          <div><strong>异常中心</strong><span>按最近更新时间展示需要处理的项目</span></div>
        </div>
        <div className="admin-exception-list">
          {failures.map((item, index) => (
            <article key={`${asText(item.kind)}-${asText(item.id, String(index))}`} className="admin-exception-row">
              <AlertTriangle size={16} />
              <div>
                <strong>{asText(item.kind)} · {asText(item.id, asText(item.email, "未知对象"))}</strong>
                <span>{asText(item.failure_code ?? item.error_code ?? item.last_error_code ?? item.last_error_message ?? item.error_message, "等待人工确认")}</span>
              </div>
              <small>{formatTimestamp(item.created_at)}</small>
            </article>
          ))}
          {!failures.length ? <div className="admin-empty compact">当前没有待处理异常。</div> : null}
        </div>
      </section>
      <section className="admin-panel">
        <div className="admin-section-head">
          <div><strong>系统状态</strong><span>关键特性开关和运行环境</span></div>
        </div>
        <div className="admin-config-grid">
          {Object.entries(config ?? {}).map(([key, value]) => (
            <article key={key}>
              <span>{key}</span>
              <strong>{typeof value === "boolean" ? (value ? "已开启" : "未开启") : asText(value)}</strong>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ConfigPanel({ data }: { data: unknown }) {
  const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const config = root.config && typeof root.config === "object" ? root.config as Record<string, unknown> : {};
  return (
    <div className="admin-panel">
      <div className="admin-section-head">
        <div><strong>配置健康</strong><span>只展示可公开的运行状态，不包含密钥或 token。</span></div>
      </div>
      <div className="admin-config-grid">
        <article><span>service</span><strong>{asText(root.service)}</strong></article>
        <article><span>environment</span><strong>{asText(root.environment)}</strong></article>
        <article><span>version</span><strong>{asText(root.version)}</strong></article>
        <article><span>database</span><strong>{asText(root.database)}</strong></article>
        {Object.entries(config).map(([key, value]) => (
          <article key={key}>
            <span>{key}</span>
            <strong>{typeof value === "boolean" ? (value ? "已开启" : "未开启") : asText(value)}</strong>
          </article>
        ))}
      </div>
    </div>
  );
}

function SummaryBar({ summary }: { summary?: Record<string, number> }) {
  const entries = Object.entries(summary ?? {});
  if (!entries.length) return null;
  return (
    <div className="admin-summary-bar">
      {entries.map(([key, count]) => <span key={key}>{statusLabel(key)} <strong>{count}</strong></span>)}
    </div>
  );
}

function DataTable({
  config,
  response,
  busyAction,
  runAction,
}: {
  config: CollectionConfig;
  response: AdminListResponse | null;
  busyAction: string;
  runAction: (row: AdminRow, action: AdminAction) => void;
}) {
  const rows = response?.items ?? [];
  return (
    <>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              {config.columns.map((column) => <th key={column.key} className={column.className}>{column.label}</th>)}
              {config.actions ? <th className="admin-actions-col">操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const rowKey = asText(row.id ?? row.cache_key, String(index));
              const actions = config.actions?.(row) ?? [];
              return (
                <tr key={rowKey}>
                  {config.columns.map((column) => (
                    <td key={column.key} data-label={column.label} className={column.className}>
                      <div className="admin-cell">{column.render ? column.render(row) : <ValueCell value={row[column.key]} />}</div>
                    </td>
                  ))}
                  {config.actions ? (
                    <td data-label="操作" className="admin-actions-col">
                      <div className="admin-row-actions">
                        {actions.map((action) => {
                          const actionKey = `${rowKey}:${action.label}`;
                          return (
                            <button key={action.label} type="button" className={action.danger ? "admin-text-action danger" : "admin-text-action"} disabled={busyAction === actionKey} onClick={() => runAction(row, action)}>
                              {busyAction === actionKey ? <RefreshCw size={14} className="spin" /> : action.icon}{action.label}
                            </button>
                          );
                        })}
                        {!actions.length ? <span className="admin-muted">—</span> : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length ? <div className="admin-empty">没有符合条件的记录。</div> : null}
      </div>
      <div className="admin-card-list">
        {rows.map((row, index) => {
          const rowKey = asText(row.id ?? row.cache_key, String(index));
          const actions = config.actions?.(row) ?? [];
          return (
            <article key={rowKey} className="admin-mobile-row">
              <div>
                <strong>{config.rowTitle(row)}</strong>
                <span>{config.rowMeta(row)}</span>
              </div>
              {config.columns.slice(0, 4).map((column) => (
                <p key={column.key}><span>{column.label}</span><b>{column.render ? column.render(row) : asText(row[column.key])}</b></p>
              ))}
              {actions.length ? (
                <div className="admin-row-actions">
                  {actions.map((action) => {
                    const actionKey = `${rowKey}:${action.label}`;
                    return (
                      <button key={action.label} type="button" className={action.danger ? "admin-text-action danger" : "admin-text-action"} disabled={busyAction === actionKey} onClick={() => runAction(row, action)}>
                        {busyAction === actionKey ? <RefreshCw size={14} className="spin" /> : action.icon}{action.label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </>
  );
}

export function AdminPage({
  toast,
  navigate,
  collection,
}: {
  toast: (message: string, error?: boolean) => void;
  navigate: (path: string) => void;
  collection?: string;
}) {
  const active = canonicalCollection(collection);
  const config = configFor(active);
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [list, setList] = useState<AdminListResponse | null>(null);
  const [configData, setConfigData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [filters, setFilters] = useState({ q: "", status: "", from: "", to: "", page: 1, pageSize: 25 });

  useEffect(() => {
    setFilters((current) => ({ ...current, status: "", page: 1 }));
  }, [active]);

  async function loadDashboard() {
    setDashboard(await api<AdminDashboard>("/api/v1/admin/dashboard"));
  }

  async function loadCurrent() {
    setLoading(true);
    try {
      if (active === "overview") {
        await loadDashboard();
        return;
      }
      if (active === "config") {
        setConfigData(await api("/api/v1/admin/config"));
        return;
      }
      const params = new URLSearchParams({
        page: String(filters.page),
        pageSize: String(filters.pageSize),
      });
      if (filters.q) params.set("q", filters.q);
      if (filters.status) params.set("status", filters.status);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      setList(await api<AdminListResponse>(`${config.endpoint}?${params.toString()}`));
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载失败", true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadCurrent(); }, [active, filters.page, filters.pageSize, filters.status, filters.from, filters.to]);

  const totalPages = Math.max(1, Math.ceil((list?.total ?? 0) / filters.pageSize));
  const visibleCollections = useMemo(() => collections, []);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFilters((current) => ({ ...current, q: String(form.get("q") ?? "").trim(), page: 1 }));
  }

  async function runAction(row: AdminRow, action: AdminAction) {
    if (!window.confirm(action.confirm)) return;
    const rowKey = asText(row.id ?? row.cache_key, "");
    const actionKey = `${rowKey}:${action.label}`;
    setBusyAction(actionKey);
    try {
      await action.run();
      toast("操作已完成");
      await Promise.all([loadCurrent(), loadDashboard().catch(() => null)]);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "操作失败", true);
    } finally {
      setBusyAction("");
    }
  }

  async function sendTestEmail() {
    try {
      await api("/api/v1/admin/emails/test", { method: "POST" });
      toast("确认邮件已发送，请检查收件箱");
      if (active === "emails") await loadCurrent();
    } catch (error) {
      toast(error instanceof Error ? error.message : "发送失败", true);
    }
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-title"><Shield size={18} /><strong>运营管理</strong></div>
        <nav aria-label="运营管理页面">
          {visibleCollections.map((item) => (
            <button key={item.id} type="button" className={active === item.id ? "active" : ""} onClick={() => navigate(item.id === "overview" ? "/admin" : `/admin/${item.id}`)}>
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <section className="admin-main">
        <div className="admin-head">
          <div>
            <span className="eyebrow">ADMIN OPERATIONS</span>
            <h1>{config.label}</h1>
            <p>{config.description}</p>
          </div>
          <div className="admin-head-actions">
            <button type="button" className="button secondary" onClick={() => void loadCurrent()} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : ""} />刷新</button>
            <button type="button" className="button primary" onClick={() => void sendTestEmail()}><Mail size={16} />测试邮件</button>
          </div>
        </div>

        {active === "overview" ? <DashboardPanel data={dashboard} /> : null}
        {active === "config" ? <ConfigPanel data={configData} /> : null}

        {active !== "overview" && active !== "config" ? (
          <div className="admin-panel">
            <form className="admin-filters" onSubmit={submitSearch}>
              <label><Search size={15} /><input name="q" defaultValue={filters.q} placeholder={config.searchPlaceholder ?? "搜索记录"} /></label>
              {config.statuses?.length ? (
                <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value, page: 1 }))}>
                  <option value="">全部状态</option>
                  {config.statuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                </select>
              ) : null}
              <input type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value, page: 1 }))} aria-label="开始日期" />
              <input type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value, page: 1 }))} aria-label="结束日期" />
              <button className="button secondary" type="submit">搜索</button>
            </form>
            <SummaryBar summary={list?.summary} />
            <DataTable config={config} response={list} busyAction={busyAction} runAction={runAction} />
            <div className="admin-pagination">
              <span>共 {list?.total ?? 0} 条</span>
              <select value={filters.pageSize} onChange={(event) => setFilters((current) => ({ ...current, pageSize: Number(event.target.value), page: 1 }))}>
                {pageSizeOptions.map((size) => <option key={size} value={size}>{size} / 页</option>)}
              </select>
              <button type="button" className="button secondary" disabled={filters.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}>上一页</button>
              <strong>{filters.page} / {totalPages}</strong>
              <button type="button" className="button secondary" disabled={filters.page >= totalPages} onClick={() => setFilters((current) => ({ ...current, page: Math.min(totalPages, current.page + 1) }))}>下一页</button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
