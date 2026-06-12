import type { AppEnv } from "../config";
import type { User } from "./auth";
import { getAccessToken } from "./credentials";
import { HttpError } from "./http";
import { fetchOfficialUserScore } from "./official";
import { readUserMetrics, userScoreSnapshotKey, type ReservationQuota } from "./user-metrics";

export type ReservationParticipant = {
  id: string;
  studentId: string;
  realName: string;
  email: string;
  isCurrentUser: boolean;
  teamName: string | null;
};

export type ReservationParticipantScore = ReservationParticipant & {
  totalScore: number | null;
  scoreRefreshedAt: number | null;
  reservationQuota: ReservationQuota[];
};

export async function listReservationParticipants(
  env: AppEnv,
  requester: User,
): Promise<ReservationParticipant[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT u.id, u.student_id, u.real_name, u.email,
            CASE WHEN u.id = ? THEN 1 ELSE 0 END AS is_current_user,
            CASE WHEN u.id = ? THEN NULL ELSE t.name END AS team_name
       FROM users u
       LEFT JOIN team_members tm ON tm.user_id = u.id
       LEFT JOIN teams t ON t.id = tm.team_id AND t.leader_user_id = ?
       JOIN official_credentials c ON c.user_id = u.id AND c.credential_status = 'ACTIVE'
      WHERE u.status = 'ACTIVE'
        AND u.student_id IS NOT NULL
        AND u.real_name IS NOT NULL
        AND (u.id = ? OR t.id IS NOT NULL)
      ORDER BY CASE WHEN u.id = ? THEN 0 ELSE 1 END, COALESCE(t.name, ''), u.real_name`,
  ).bind(requester.id, requester.id, requester.id, requester.id, requester.id).all<{
    id: string;
    student_id: string;
    real_name: string;
    email: string;
    is_current_user: number;
    team_name: string | null;
  }>();

  return rows.results.map((row) => ({
    id: row.id,
    studentId: row.student_id,
    realName: row.real_name,
    email: row.email,
    isCurrentUser: row.is_current_user === 1,
    teamName: row.team_name,
  }));
}

export async function resolveOrderedParticipants(
  env: AppEnv,
  requester: User,
  participantUserIds: unknown,
): Promise<ReservationParticipant[]> {
  if (!Array.isArray(participantUserIds) || participantUserIds.length === 0 || participantUserIds.length > 20) {
    throw new HttpError(400, "PARTICIPANTS_REQUIRED", "请至少选择一位小队成员");
  }
  const ids = participantUserIds.map((value) => {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "INVALID_PARTICIPANTS", "预约成员格式错误");
    return value.trim();
  });
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "DUPLICATE_PARTICIPANTS", "预约成员不能重复");

  const allowed = new Map((await listReservationParticipants(env, requester)).map((participant) => [participant.id, participant]));
  const participants = ids.map((id) => allowed.get(id));
  if (participants.some((participant) => !participant)) {
    throw new HttpError(403, "TEAM_MEMBER_REQUIRED", "只能选择自己或自己带领小队中的有效成员");
  }
  return participants as ReservationParticipant[];
}

export async function fetchReservationParticipantScores(
  env: AppEnv,
  requester: User,
): Promise<ReservationParticipantScore[]> {
  const participants = await listReservationParticipants(env, requester);
  const token = await getAccessToken(env, requester.id);
  const existingMetrics = await readUserMetrics(env, participants.map((participant) => participant.id));
  const scores: ReservationParticipantScore[] = [];
  for (const participant of participants) {
    const previous = existingMetrics.get(participant.id);
    let totalScore = previous?.totalScore ?? null;
    let scoreRefreshedAt = previous?.scoreRefreshedAt ?? null;
    try {
      const score = await fetchOfficialUserScore(env, token, participant.studentId);
      totalScore = score.totalScore;
      scoreRefreshedAt = Date.now();
      if (env.OFFICIAL_GATEWAY) {
        const snapshot = await env.OFFICIAL_GATEWAY.writeSnapshot({
          key: userScoreSnapshotKey(participant.id),
          scope: "USER",
          ownerUserId: participant.id,
          kind: "USER_SCORE",
          value: score,
          freshForMs: 10 * 60_000,
          staleForMs: 6 * 60 * 60_000,
        });
        scoreRefreshedAt = snapshot.refreshedAt;
      }
    } catch {
      // Keep the last successful score snapshot instead of replacing it with an unknown value.
    }
    scores.push({
      ...participant,
      totalScore,
      scoreRefreshedAt,
      reservationQuota: previous?.reservationQuota ?? [],
    });
  }
  return scores;
}

export async function assertPrimaryReservationScore(env: AppEnv, primary: ReservationParticipant): Promise<void> {
  const previous = (await readUserMetrics(env, [primary.id])).get(primary.id);
  let totalScore = previous?.totalScore ?? null;
  try {
    const score = await fetchOfficialUserScore(env, await getAccessToken(env, primary.id), primary.studentId);
    totalScore = score.totalScore;
    if (env.OFFICIAL_GATEWAY) {
      await env.OFFICIAL_GATEWAY.writeSnapshot({
        key: userScoreSnapshotKey(primary.id),
        scope: "USER",
        ownerUserId: primary.id,
        kind: "USER_SCORE",
        value: score,
        freshForMs: 10 * 60_000,
        staleForMs: 6 * 60 * 60_000,
      });
    }
  } catch {
    // A stale successful score is still more useful than discarding it during a transient failure.
  }
  if (totalScore === null || totalScore <= 0) {
    throw new HttpError(409, "PRIMARY_SCORE_INSUFFICIENT", "主预约人积分必须大于 0，当前积分暂不可用或已用尽");
  }
}
