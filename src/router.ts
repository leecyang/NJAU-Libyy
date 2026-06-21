import type { AppEnv } from "./config";
import {
  adminCancelGatewayJob,
  adminCancelTask,
  adminCollection,
  adminConfig,
  adminRequireCredentialRebind,
  adminRetryEmail,
  adminRetryGatewayJob,
  adminTestEmail,
  adminUserStatus,
  bind,
  cancelReservation,
  cancelSignWorkflow,
  changeTaskStatus,
  createInvitation,
  openReservationDoor,
  createSignLink,
  createSignWorkflowTask,
  createTask,
  createTeam,
  dashboard,
  deleteAccount,
  deleteTeam,
  getCredentialStatus,
  gatewayJobStatus,
  health,
  inviteTeamMember,
  invitableUsers,
  leaveTeam,
  listMyTeams,
  teamDetail,
  teamMemberReservations,
  refreshTeamMemberReservations,
  listSignWorkflows,
  listTasks,
  manualReservation,
  me,
  refreshMe,
  officialUserSearch,
  receivedInvitations,
  recentContacts,
  removeTeamMember,
  reservationDetail,
  reservationHistory,
  reservationParticipants,
  refreshReservationOptions,
  refreshReservationParticipants,
  refreshRooms,
  respondInvitation,
  respondTeamInvitation,
  roomDetail,
  rooms,
  signTasks,
  signoutReservation,
  signoutTasks,
  submitCredentialSms,
  syncReservationHistory,
  taskDetail,
  teamInvitationPreview,
  updateTask,
  updateTeam,
} from "./api/app";
import { refreshTeamMemberMetrics, teamMemberMetrics } from "./api/team-scores";
import { openTeamDoor, teamDoorOptions } from "./api/team-door";
import { login, logout, register, resetPassword, sendRegisterCode, sendResetCode } from "./api/auth";
import { json } from "./lib/http";

type Handler = (env: AppEnv, request: Request) => Promise<Response>;

const routes = new Map<string, Handler>([
  ["GET /api/v1/health", health],
  ["GET /api/v1/me", me],
  ["POST /api/v1/me/refresh", refreshMe],
  ["POST /api/v1/auth/send-register-code", sendRegisterCode],
  ["POST /api/v1/auth/register", register],
  ["POST /api/v1/auth/login", login],
  ["POST /api/v1/auth/logout", logout],
  ["POST /api/v1/auth/send-reset-code", sendResetCode],
  ["POST /api/v1/auth/reset-password", resetPassword],
  ["POST /api/v1/account/delete", deleteAccount],
  ["POST /api/v1/credentials/bind", bind],
  ["POST /api/v1/credentials/rebind", bind],
  ["POST /api/v1/credentials/sms", submitCredentialSms],
  ["GET /api/v1/credentials/status", getCredentialStatus],
  ["GET /api/v1/rooms", rooms],
  ["POST /api/v1/rooms/refresh", refreshRooms],
  ["POST /api/v1/reservations/manual", manualReservation],
  ["GET /api/v1/reservations/history", reservationHistory],
  ["POST /api/v1/reservations/sync", syncReservationHistory],
  ["GET /api/v1/reservation-participants", reservationParticipants],
  ["POST /api/v1/reservation-participants/refresh", refreshReservationParticipants],
  ["GET /api/v1/reservation-options", refreshReservationOptions],
  ["POST /api/v1/reservation-options/refresh", refreshReservationOptions],
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
  ["POST /api/v1/sign-workflows", createSignWorkflowTask],
  ["GET /api/v1/sign-workflows", listSignWorkflows],
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

  const gatewayJobMatch = /^\/api\/v1\/official-jobs\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && gatewayJobMatch?.[1]) return gatewayJobStatus(env, request, gatewayJobMatch[1]);

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
  const reservationOpenDoorMatch = /^\/api\/v1\/reservations\/([^/]+)\/open-door$/.exec(url.pathname);
  if (request.method === "POST" && reservationOpenDoorMatch?.[1]) return openReservationDoor(env, request, reservationOpenDoorMatch[1]);

  const roomDetailMatch = /^\/api\/v1\/rooms\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && roomDetailMatch?.[1]) return roomDetail(env, request, roomDetailMatch[1]);

  const teamInvitationMatch = /^\/api\/v1\/team-invitations\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && teamInvitationMatch?.[1]) return teamInvitationPreview(env, request, teamInvitationMatch[1]);
  const teamInvitationRespondMatch = /^\/api\/v1\/team-invitations\/([^/]+)\/respond$/.exec(url.pathname);
  if (request.method === "POST" && teamInvitationRespondMatch?.[1]) return respondTeamInvitation(env, request, teamInvitationRespondMatch[1]);

  const teamMatch = /^\/api\/v1\/teams\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && teamMatch?.[1]) return teamDetail(env, request, teamMatch[1]);
  if (request.method === "PATCH" && teamMatch?.[1]) return updateTeam(env, request, teamMatch[1]);
  if (request.method === "DELETE" && teamMatch?.[1]) return deleteTeam(env, request, teamMatch[1]);
  const teamInviteMatch = /^\/api\/v1\/teams\/([^/]+)\/invitations$/.exec(url.pathname);
  if (request.method === "POST" && teamInviteMatch?.[1]) return inviteTeamMember(env, request, teamInviteMatch[1]);
  const teamDoorOptionsMatch = /^\/api\/v1\/teams\/([^/]+)\/door-options$/.exec(url.pathname);
  if (request.method === "POST" && teamDoorOptionsMatch?.[1]) return teamDoorOptions(env, request, teamDoorOptionsMatch[1]);
  const teamOpenDoorMatch = /^\/api\/v1\/teams\/([^/]+)\/open-door$/.exec(url.pathname);
  if (request.method === "POST" && teamOpenDoorMatch?.[1]) return openTeamDoor(env, request, teamOpenDoorMatch[1]);
  const teamLeaveMatch = /^\/api\/v1\/teams\/([^/]+)\/members\/me$/.exec(url.pathname);
  if (request.method === "DELETE" && teamLeaveMatch?.[1]) return leaveTeam(env, request, teamLeaveMatch[1]);
  const teamMemberMatch = /^\/api\/v1\/teams\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && teamMemberMatch?.[1] && teamMemberMatch[2]) return removeTeamMember(env, request, teamMemberMatch[1], teamMemberMatch[2]);
  const teamMemberReservationsMatch = /^\/api\/v1\/teams\/([^/]+)\/members\/([^/]+)\/reservations$/.exec(url.pathname);
  if (request.method === "GET" && teamMemberReservationsMatch?.[1] && teamMemberReservationsMatch[2]) {
    return teamMemberReservations(env, request, teamMemberReservationsMatch[1], teamMemberReservationsMatch[2]);
  }
  const teamMemberReservationsRefreshMatch = /^\/api\/v1\/teams\/([^/]+)\/members\/([^/]+)\/reservations\/refresh$/.exec(url.pathname);
  if (request.method === "POST" && teamMemberReservationsRefreshMatch?.[1] && teamMemberReservationsRefreshMatch[2]) {
    return refreshTeamMemberReservations(env, request, teamMemberReservationsRefreshMatch[1], teamMemberReservationsRefreshMatch[2]);
  }

  const teamMetricsMatch = /^\/api\/v1\/teams\/([^/]+)\/member-metrics$/.exec(url.pathname);
  if (request.method === "GET" && teamMetricsMatch?.[1]) return teamMemberMetrics(env, request, teamMetricsMatch[1]);
  if (request.method === "POST" && teamMetricsMatch?.[1]) return refreshTeamMemberMetrics(env, request, teamMetricsMatch[1]);

  const invitationAction = /^\/api\/v1\/invitations\/([^/]+)\/(accept|reject)$/.exec(url.pathname);
  if (request.method === "POST" && invitationAction?.[1] && (invitationAction[2] === "accept" || invitationAction[2] === "reject")) {
    return respondInvitation(env, request, invitationAction[1], invitationAction[2]);
  }

  const signWorkflowCancelMatch = /^\/api\/v1\/sign-workflows\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && signWorkflowCancelMatch?.[1]) return cancelSignWorkflow(env, request, signWorkflowCancelMatch[1]);

  const adminList = /^\/api\/v1\/admin\/(users|credentials|tasks|reservations|invitations|teams|team-invitations|sign-tasks|signout-tasks|emails|audit-logs|gateway-jobs|gateway-snapshots)$/.exec(url.pathname);
  if (request.method === "GET" && adminList?.[1]) return adminCollection(env, request, adminList[1]);

  const adminStatus = /^\/api\/v1\/admin\/users\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "PATCH" && adminStatus?.[1]) return adminUserStatus(env, request, adminStatus[1]);
  const adminCredentialRebind = /^\/api\/v1\/admin\/users\/([^/]+)\/require-rebind$/.exec(url.pathname);
  if (request.method === "POST" && adminCredentialRebind?.[1]) return adminRequireCredentialRebind(env, request, adminCredentialRebind[1]);
  const adminTaskCancel = /^\/api\/v1\/admin\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && adminTaskCancel?.[1]) return adminCancelTask(env, request, adminTaskCancel[1]);
  const adminEmailRetry = /^\/api\/v1\/admin\/emails\/([^/]+)\/retry$/.exec(url.pathname);
  if (request.method === "POST" && adminEmailRetry?.[1]) return adminRetryEmail(env, request, adminEmailRetry[1]);
  const adminGatewayCancel = /^\/api\/v1\/admin\/gateway-jobs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && adminGatewayCancel?.[1]) return adminCancelGatewayJob(env, request, adminGatewayCancel[1]);
  const adminGatewayRetry = /^\/api\/v1\/admin\/gateway-jobs\/([^/]+)\/retry$/.exec(url.pathname);
  if (request.method === "POST" && adminGatewayRetry?.[1]) return adminRetryGatewayJob(env, request, adminGatewayRetry[1]);

  return json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, 404);
}
