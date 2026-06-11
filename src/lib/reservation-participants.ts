import type { AppEnv } from "../config";
import type { User } from "./auth";
import { getAccessToken } from "./credentials";
import { HttpError } from "./http";
import { fetchOfficialUserScore } from "./official";

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
  const scores: ReservationParticipantScore[] = [];
  for (const participant of participants) {
    let totalScore: number | null = null;
    try {
      totalScore = (await fetchOfficialUserScore(env, token, participant.studentId)).totalScore;
    } catch {
      totalScore = null;
    }
    scores.push({ ...participant, totalScore });
  }
  return scores;
}

export async function assertPrimaryReservationScore(env: AppEnv, primary: ReservationParticipant): Promise<void> {
  let totalScore: number | null = null;
  try {
    totalScore = (await fetchOfficialUserScore(env, await getAccessToken(env, primary.id), primary.studentId)).totalScore;
  } catch {
    totalScore = null;
  }
  if (totalScore === null || totalScore < 2) {
    throw new HttpError(409, "PRIMARY_SCORE_INSUFFICIENT", "主预约人剩余积分不足 2 分或暂时无法获取");
  }
}
