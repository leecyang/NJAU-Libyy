import type { AppEnv } from "../config";
import { requireUser, type User } from "../lib/auth";
import { credentialStatus, getAccessToken } from "../lib/credentials";
import { HttpError, ok } from "../lib/http";
import { fetchOfficialUserScore } from "../lib/official";
import { publicGatewayJob, type OfficialGatewayJob } from "../lib/official-gateway-types";

async function requireBoundUser(env: AppEnv, request: Request): Promise<User> {
  const user = await requireUser(env, request);
  const credential = await credentialStatus(env, user.id);
  if (!user.student_id || !user.real_name || credential.credential_status !== "ACTIVE" || credential.setup_required === true) {
    throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  }
  return user;
}

export async function teamMemberScores(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const team = await env.DB.prepare(
    `SELECT id, name, leader_user_id FROM teams WHERE id = ?`,
  ).bind(teamId).first<{ id: string; name: string; leader_user_id: string }>();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "小队不存在");
  if (team.leader_user_id !== leader.id) throw new HttpError(403, "NOT_TEAM_LEADER", "仅队长可查看成员积分");
  if (!leader.student_id) throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");

  if (env.OFFICIAL_GATEWAY) {
    const snapshot = await env.OFFICIAL_GATEWAY.readSnapshot<{ teamId: string; teamName: string; members: Array<{ userId: string; realName: string; totalScore: number | null }> }>(teamScoresSnapshotKey(leader.id, teamId));
    return ok(snapshot?.value ?? { teamId: team.id, teamName: team.name, members: [] });
  }
  return ok(await fetchTeamScores(env, leader, team));
}

function teamScoresSnapshotKey(userId: string, teamId: string): string {
  return `user:${userId}:team:${teamId}:scores`;
}

async function fetchTeamScores(env: AppEnv, leader: User, team: { id: string; name: string }): Promise<{ teamId: string; teamName: string; members: Array<{ userId: string; realName: string; totalScore: number | null }> }> {
  const members = await env.DB.prepare(
    `SELECT u.id, u.student_id, u.real_name FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? AND u.status = 'ACTIVE' AND u.student_id IS NOT NULL`,
  ).bind(team.id).all<{ id: string; student_id: string; real_name: string }>();

  const token = await getAccessToken(env, leader.id);
  if (!leader.student_id) throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  const leaderStudentId = leader.student_id;
  const scores: Array<{ userId: string; realName: string; totalScore: number | null }> = [];

  let leaderScore: number | null = null;
  try {
    const score = await fetchOfficialUserScore(env, token, leaderStudentId);
    leaderScore = score.totalScore;
  } catch {
    leaderScore = null;
  }
  scores.push({ userId: leaderStudentId, realName: leader.real_name ?? leader.email, totalScore: leaderScore });

  for (const member of members.results) {
    let memberScore: number | null = null;
    try {
      const score = await fetchOfficialUserScore(env, token, member.student_id);
      memberScore = score.totalScore;
    } catch {
      memberScore = null;
    }
    scores.push({ userId: member.student_id, realName: member.real_name, totalScore: memberScore });
  }

  return { teamId: team.id, teamName: team.name, members: scores };
}

async function executeTeamScoresRefresh(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "队伍积分任务缺少用户");
  const teamId = String(job.payload.teamId ?? "");
  const leader = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.status, u.student_id, u.real_name,
            u.allow_auto_join_reservation, u.square_visibility
       FROM users u WHERE u.id = ?`,
  ).bind(job.ownerUserId).first<User>();
  if (!leader || !leader.student_id) throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  const team = await env.DB.prepare("SELECT id, name, leader_user_id FROM teams WHERE id = ?").bind(teamId)
    .first<{ id: string; name: string; leader_user_id: string }>();
  if (!team || team.leader_user_id !== leader.id) throw new HttpError(404, "TEAM_NOT_FOUND", "小队不存在");
  const value = await fetchTeamScores(env, leader, team);
  const snapshot = await env.OFFICIAL_GATEWAY!.writeSnapshot({
    key: teamScoresSnapshotKey(leader.id, team.id),
    scope: "USER",
    ownerUserId: leader.id,
    kind: "TEAM_SCORES",
    value,
    freshForMs: 10 * 60_000,
    staleForMs: 6 * 60 * 60_000,
    refreshJobId: job.id,
  });
  return { snapshotKey: snapshot.key, version: snapshot.version, count: value.members.length };
}

export function registerTeamScoresGatewayHandler(env: AppEnv): void {
  env.OFFICIAL_GATEWAY?.registerHandler("TEAM_SCORES_REFRESH", (job) => executeTeamScoresRefresh(env, job));
}

export async function refreshTeamMemberScores(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  if (!env.OFFICIAL_GATEWAY) throw new HttpError(503, "OFFICIAL_GATEWAY_UNAVAILABLE", "官方访问网关尚未启动");
  const team = await env.DB.prepare("SELECT id FROM teams WHERE id = ? AND leader_user_id = ?").bind(teamId, leader.id).first();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "小队不存在");
  const key = teamScoresSnapshotKey(leader.id, teamId);
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "TEAM_SCORES_REFRESH",
    lane: "READ",
    ownerUserId: leader.id,
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
