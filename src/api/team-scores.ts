import type { AppEnv } from "../config";
import { requireUser, type User } from "../lib/auth";
import { credentialStatus, getAccessToken } from "../lib/credentials";
import { HttpError, ok } from "../lib/http";
import { fetchOfficialUserScore } from "../lib/official";
import { publicGatewayJob, type OfficialGatewayJob } from "../lib/official-gateway-types";
import { readUserMetrics, userScoreSnapshotKey, type ReservationQuota } from "../lib/user-metrics";

async function requireBoundUser(env: AppEnv, request: Request): Promise<User> {
  const user = await requireUser(env, request);
  const credential = await credentialStatus(env, user.id);
  if (!user.student_id || !user.real_name || credential.credential_status !== "ACTIVE" || credential.setup_required === true) {
    throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  }
  return user;
}

type TeamRow = { id: string; name: string; leader_user_id: string };
type TeamMetricMember = {
  localUserId: string;
  userId: string;
  studentId: string;
  realName: string;
  totalScore: number | null;
  scoreRefreshedAt: number | null;
  reservationQuota: ReservationQuota[];
  isCurrentUser: boolean;
  isLeader: boolean;
};

async function requireTeamMember(env: AppEnv, userId: string, teamId: string): Promise<TeamRow> {
  const team = await env.DB.prepare(
    `SELECT t.id, t.name, t.leader_user_id
       FROM teams t
      WHERE t.id = ? AND (t.leader_user_id = ? OR EXISTS (
        SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = ?
      ))`,
  ).bind(teamId, userId, userId).first<TeamRow>();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "小队不存在或你已不在队内");
  return team;
}

function teamMetricsSnapshotKey(userId: string, teamId: string): string {
  return `user:${userId}:team:${teamId}:metrics`;
}

async function fetchTeamMetrics(env: AppEnv, requester: User, team: TeamRow): Promise<{ teamId: string; teamName: string; members: TeamMetricMember[] }> {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.student_id, u.real_name,
            CASE WHEN u.id = ? THEN 1 ELSE 0 END AS is_leader
       FROM users u
      WHERE u.id = ? OR u.id IN (SELECT user_id FROM team_members WHERE team_id = ?)
      ORDER BY is_leader DESC, u.real_name`,
  ).bind(team.leader_user_id, team.leader_user_id, team.id).all<{
    id: string;
    student_id: string | null;
    real_name: string | null;
    is_leader: number;
  }>();
  const eligible = rows.results.filter((row): row is typeof row & { student_id: string } => Boolean(row.student_id));
  const previous = await readUserMetrics(env, eligible.map((row) => row.id));
  const token = await getAccessToken(env, requester.id);
  const members: TeamMetricMember[] = [];

  for (const row of eligible) {
    const old = previous.get(row.id);
    let totalScore = old?.totalScore ?? null;
    let scoreRefreshedAt = old?.scoreRefreshedAt ?? null;
    try {
      const score = await fetchOfficialUserScore(env, token, row.student_id);
      totalScore = score.totalScore;
      scoreRefreshedAt = Date.now();
      if (env.OFFICIAL_GATEWAY) {
        const snapshot = await env.OFFICIAL_GATEWAY.writeSnapshot({
          key: userScoreSnapshotKey(row.id),
          scope: "USER",
          ownerUserId: row.id,
          kind: "USER_SCORE",
          value: score,
          freshForMs: 10 * 60_000,
          staleForMs: 6 * 60 * 60_000,
        });
        scoreRefreshedAt = snapshot.refreshedAt;
      }
    } catch {
      // Preserve the last successful score when one member cannot be refreshed.
    }
    members.push({
      localUserId: row.id,
      userId: row.student_id,
      studentId: row.student_id,
      realName: row.real_name ?? row.student_id,
      totalScore,
      scoreRefreshedAt,
      reservationQuota: old?.reservationQuota ?? [],
      isCurrentUser: row.id === requester.id,
      isLeader: row.is_leader === 1,
    });
  }
  return { teamId: team.id, teamName: team.name, members };
}

export async function teamMemberMetrics(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  const team = await requireTeamMember(env, requester.id, teamId);
  if (env.OFFICIAL_GATEWAY) {
    const snapshot = await env.OFFICIAL_GATEWAY.readSnapshot<{ teamId: string; teamName: string; members: TeamMetricMember[] }>(teamMetricsSnapshotKey(requester.id, teamId));
    if (snapshot) {
      const live = await readUserMetrics(env, snapshot.value.members.map((member) => member.localUserId));
      return ok({
        ...snapshot.value,
        members: snapshot.value.members.map((member) => ({
          ...member,
          reservationQuota: live.get(member.localUserId)?.reservationQuota ?? member.reservationQuota,
        })),
        cache: { status: snapshot.freshness, refreshedAt: snapshot.refreshedAt },
      });
    }
  }
  return ok(await fetchTeamMetrics(env, requester, team));
}

async function executeTeamMetricsRefresh(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "队伍指标任务缺少用户");
  const teamId = String(job.payload.teamId ?? "");
  const requester = await env.DB.prepare(
    `SELECT id, email, role, status, student_id, real_name,
            allow_auto_join_reservation, square_visibility
       FROM users WHERE id = ?`,
  ).bind(job.ownerUserId).first<User>();
  if (!requester || !requester.student_id) throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  const team = await requireTeamMember(env, requester.id, teamId);
  const value = await fetchTeamMetrics(env, requester, team);
  const snapshot = await env.OFFICIAL_GATEWAY!.writeSnapshot({
    key: teamMetricsSnapshotKey(requester.id, team.id),
    scope: "USER",
    ownerUserId: requester.id,
    kind: "TEAM_METRICS",
    value,
    freshForMs: 10 * 60_000,
    staleForMs: 6 * 60 * 60_000,
    refreshJobId: job.id,
  });
  return { snapshotKey: snapshot.key, version: snapshot.version, count: value.members.length };
}

export function registerTeamScoresGatewayHandler(env: AppEnv): void {
  env.OFFICIAL_GATEWAY?.registerHandler("TEAM_SCORES_REFRESH", (job) => executeTeamMetricsRefresh(env, job));
}

export async function refreshTeamMemberMetrics(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  await requireTeamMember(env, requester.id, teamId);
  if (!env.OFFICIAL_GATEWAY) return ok(await fetchTeamMetrics(env, requester, await requireTeamMember(env, requester.id, teamId)));
  const key = teamMetricsSnapshotKey(requester.id, teamId);
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "TEAM_SCORES_REFRESH",
    lane: "READ",
    ownerUserId: requester.id,
    dedupeKey: `refresh:${key}`,
    payload: { teamId },
    priority: 35,
  });
  await env.OFFICIAL_GATEWAY.linkSnapshotRefresh(key, job.id);
  return new Response(JSON.stringify({ ok: true, data: publicGatewayJob(job) }), {
    status: 202,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const teamMemberScores = teamMemberMetrics;
export const refreshTeamMemberScores = refreshTeamMemberMetrics;
