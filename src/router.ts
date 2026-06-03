import type { AppEnv } from "./config";
import {
  adminCollection,
  adminConfig,
  adminTestEmail,
  adminUserStatus,
  bind,
  cancelReservation,
  changeTaskStatus,
  clearCredential,
  createInvitation,
  createSignLink,
  createTask,
  createTeam,
  dashboard,
  deleteAccount,
  deleteTeam,
  getCredentialStatus,
  health,
  inviteTeamMember,
  invitableUsers,
  leaveTeam,
  listMyTeams,
  listTasks,
  manualReservation,
  me,
  officialUserSearch,
  receivedInvitations,
  recentContacts,
  removeTeamMember,
  reservationDetail,
  reservationHistory,
  respondInvitation,
  respondTeamInvitation,
  roomDetail,
  rooms,
  signTasks,
  signoutReservation,
  signoutTasks,
  submitSignParameters,
  syncReservationHistory,
  taskDetail,
  teamInvitationPreview,
  updateTask,
} from "./api/app";
import { login, logout, register, resetPassword, sendRegisterCode, sendResetCode } from "./api/auth";
import { json } from "./lib/http";

type Handler = (env: AppEnv, request: Request) => Promise<Response>;

const routes = new Map<string, Handler>([
  ["GET /api/v1/health", health],
  ["GET /api/v1/me", me],
  ["POST /api/v1/auth/send-register-code", sendRegisterCode],
  ["POST /api/v1/auth/register", register],
  ["POST /api/v1/auth/login", login],
  ["POST /api/v1/auth/logout", logout],
  ["POST /api/v1/auth/send-reset-code", sendResetCode],
  ["POST /api/v1/auth/reset-password", resetPassword],
  ["POST /api/v1/account/delete", deleteAccount],
  ["POST /api/v1/credentials/bind", bind],
  ["POST /api/v1/credentials/rebind", bind],
  ["POST /api/v1/credentials/clear", clearCredential],
  ["GET /api/v1/credentials/status", getCredentialStatus],
  ["GET /api/v1/rooms", rooms],
  ["POST /api/v1/reservations/manual", manualReservation],
  ["GET /api/v1/reservations/history", reservationHistory],
  ["POST /api/v1/reservations/sync", syncReservationHistory],
  ["POST /api/v1/reservation-tasks", createTask],
  ["GET /api/v1/reservation-tasks", listTasks],
  ["GET /api/v1/users/invitable", invitableUsers],
  ["GET /api/v1/official-users/search", officialUserSearch],
  ["GET /api/v1/recent-contacts", recentContacts],
  ["POST /api/v1/teams", createTeam],
  ["GET /api/v1/teams/mine", listMyTeams],
  ["POST /api/v1/invitations", createInvitation],
  ["GET /api/v1/invitations/received", receivedInvitations],
  ["GET /api/v1/sign-tasks", signTasks],
  ["GET /api/v1/signout-tasks", signoutTasks],
  ["GET /api/v1/admin/dashboard", dashboard],
  ["GET /api/v1/admin/config", adminConfig],
  ["POST /api/v1/admin/emails/test", adminTestEmail],
]);

export async function routeApi(env: AppEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const direct = routes.get(`${request.method} ${url.pathname}`);
  if (direct) return direct(env, request);

  const taskAction = /^\/api\/v1\/reservation-tasks\/([^/]+)\/(enable|cancel)$/.exec(url.pathname);
  if (request.method === "POST" && taskAction?.[1] && (taskAction[2] === "enable" || taskAction[2] === "cancel")) {
    return changeTaskStatus(env, request, taskAction[1], taskAction[2]);
  }

  const taskDetailMatch = /^\/api\/v1\/reservation-tasks\/([^/]+)$/.exec(url.pathname);
  if (taskDetailMatch?.[1] && request.method === "GET") return taskDetail(env, request, taskDetailMatch[1]);
  if (taskDetailMatch?.[1] && request.method === "PATCH") return updateTask(env, request, taskDetailMatch[1]);

  const reservationDetailMatch = /^\/api\/v1\/reservations\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && reservationDetailMatch?.[1]) return reservationDetail(env, request, reservationDetailMatch[1]);
  const reservationCancelMatch = /^\/api\/v1\/reservations\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && reservationCancelMatch?.[1]) return cancelReservation(env, request, reservationCancelMatch[1]);
  const reservationSignLinkMatch = /^\/api\/v1\/reservations\/([^/]+)\/sign-link$/.exec(url.pathname);
  if (request.method === "POST" && reservationSignLinkMatch?.[1]) return createSignLink(env, request, reservationSignLinkMatch[1]);
  const reservationSignoutMatch = /^\/api\/v1\/reservations\/([^/]+)\/signout$/.exec(url.pathname);
  if (request.method === "POST" && reservationSignoutMatch?.[1]) return signoutReservation(env, request, reservationSignoutMatch[1]);

  const roomDetailMatch = /^\/api\/v1\/rooms\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && roomDetailMatch?.[1]) return roomDetail(env, request, roomDetailMatch[1]);

  const teamInvitationMatch = /^\/api\/v1\/team-invitations\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && teamInvitationMatch?.[1]) return teamInvitationPreview(env, request, teamInvitationMatch[1]);
  const teamInvitationRespondMatch = /^\/api\/v1\/team-invitations\/([^/]+)\/respond$/.exec(url.pathname);
  if (request.method === "POST" && teamInvitationRespondMatch?.[1]) return respondTeamInvitation(env, request, teamInvitationRespondMatch[1]);

  const teamMatch = /^\/api\/v1\/teams\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && teamMatch?.[1]) return deleteTeam(env, request, teamMatch[1]);
  const teamInviteMatch = /^\/api\/v1\/teams\/([^/]+)\/invitations$/.exec(url.pathname);
  if (request.method === "POST" && teamInviteMatch?.[1]) return inviteTeamMember(env, request, teamInviteMatch[1]);
  const teamLeaveMatch = /^\/api\/v1\/teams\/([^/]+)\/members\/me$/.exec(url.pathname);
  if (request.method === "DELETE" && teamLeaveMatch?.[1]) return leaveTeam(env, request, teamLeaveMatch[1]);
  const teamMemberMatch = /^\/api\/v1\/teams\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && teamMemberMatch?.[1] && teamMemberMatch[2]) return removeTeamMember(env, request, teamMemberMatch[1], teamMemberMatch[2]);

  const invitationAction = /^\/api\/v1\/invitations\/([^/]+)\/(accept|reject)$/.exec(url.pathname);
  if (request.method === "POST" && invitationAction?.[1] && (invitationAction[2] === "accept" || invitationAction[2] === "reject")) {
    return respondInvitation(env, request, invitationAction[1], invitationAction[2]);
  }

  const signParameterMatch = /^\/api\/v1\/sign-tasks\/([^/]+)\/parameters$/.exec(url.pathname);
  if (request.method === "POST" && signParameterMatch?.[1]) return submitSignParameters(env, request, signParameterMatch[1]);

  const adminList = /^\/api\/v1\/admin\/(users|credentials|tasks|reservations|invitations|teams|team-invitations|sign-tasks|signout-tasks|emails|audit-logs)$/.exec(url.pathname);
  if (request.method === "GET" && adminList?.[1]) return adminCollection(env, request, adminList[1]);

  const adminStatus = /^\/api\/v1\/admin\/users\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "PATCH" && adminStatus?.[1]) return adminUserStatus(env, request, adminStatus[1]);

  return json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, 404);
}
