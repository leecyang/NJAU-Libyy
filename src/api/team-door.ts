import type { AppEnv } from "../config";
import { requireUser, type User } from "../lib/auth";
import { audit } from "../lib/audit";
import { credentialStatus, getAccessToken } from "../lib/credentials";
import { HttpError, json, ok, readJsonBody, requireString } from "../lib/http";
import { publicGatewayJob, type OfficialGatewayJob } from "../lib/official-gateway-types";
import { createOfficialQrSignCheckCode, submitOfficialSign, type OfficialReservationRecord } from "../lib/official";
import { officialMemberSnapshot, resolveSignDevice, shanghaiParts, syncOfficialReservationHistory } from "../lib/reservations";
import { canonicalReservationSource } from "../lib/user-metrics";

type TeamDoorMember = {
  id: string;
  studentId: string;
  realName: string;
};

type TeamDoorCandidate = TeamDoorMember & {
  officialReservationId: string;
};

export type TeamDoorOption = {
  id: string;
  roomId: number;
  roomName: string;
  date: string;
  startTime: string;
  endTime: string;
  startTimestamp: number;
  endTimestamp: number;
  participants: Array<{ studentId: string; realName: string }>;
  signedInMembers: TeamDoorMember[];
};

type TeamDoorOptionsResult = {
  options: TeamDoorOption[];
  warnings: Array<{ userId: string; realName: string; message: string }>;
};

type TeamDoorGroup = TeamDoorOption & { candidates: TeamDoorCandidate[] };

async function requireBoundUser(env: AppEnv, request: Request): Promise<User> {
  const user = await requireUser(env, request);
  const credential = await credentialStatus(env, user.id);
  if (!user.student_id || !user.real_name || credential.credential_status !== "ACTIVE" || credential.setup_required === true) {
    throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  }
  return user;
}

async function requireTeamLeader(env: AppEnv, userId: string, teamId: string): Promise<{ id: string; name: string }> {
  const team = await env.DB.prepare("SELECT id, name FROM teams WHERE id = ? AND leader_user_id = ?")
    .bind(teamId, userId).first<{ id: string; name: string }>();
  if (!team) throw new HttpError(403, "TEAM_LEADER_REQUIRED", "只有小队队长可以管理开门");
  return team;
}

async function teamDoorMembers(env: AppEnv, teamId: string): Promise<TeamDoorMember[]> {
  const rows = await env.DB.prepare(
    `SELECT user.id, user.student_id, user.real_name
       FROM users user
       JOIN teams team ON team.id = ?
      WHERE user.status = 'ACTIVE'
        AND user.student_id IS NOT NULL
        AND user.real_name IS NOT NULL
        AND (user.id = team.leader_user_id OR user.id IN (
          SELECT member.user_id FROM team_members member WHERE member.team_id = team.id
        ))
      ORDER BY CASE WHEN user.id = team.leader_user_id THEN 0 ELSE 1 END, user.real_name`,
  ).bind(teamId).all<{ id: string; student_id: string; real_name: string }>();
  return rows.results.map((row) => ({ id: row.id, studentId: row.student_id, realName: row.real_name }));
}

function activeSignedRecord(record: OfficialReservationRecord, now: number): boolean {
  return record.reservationStatus === 31 && record.startTime <= now && now < record.endTime;
}

export function publicTeamDoorGroups(groups: TeamDoorGroup[]): TeamDoorOption[] {
  return groups.map(({ candidates: _candidates, ...option }) => option);
}

async function buildTeamDoorOptions(env: AppEnv, leaderId: string, teamId: string, now = Date.now()): Promise<TeamDoorOptionsResult & { groups: TeamDoorGroup[] }> {
  await requireTeamLeader(env, leaderId, teamId);
  const members = await teamDoorMembers(env, teamId);
  const groups = new Map<string, TeamDoorGroup>();
  const warnings: TeamDoorOptionsResult["warnings"] = [];

  for (const member of members) {
    try {
      const user = await env.DB.prepare(
        `SELECT id, email, role, status, student_id, real_name,
                allow_auto_join_reservation, square_visibility
           FROM users WHERE id = ?`,
      ).bind(member.id).first<User>();
      if (!user) continue;
      const records = await syncOfficialReservationHistory(env, user);
      for (const record of records) {
        if (!activeSignedRecord(record, now)) continue;
        const times = { start: shanghaiParts(record.startTime), end: shanghaiParts(record.endTime) };
        const snapshot = await officialMemberSnapshot(env, record);
        const participants = snapshot.length
          ? snapshot.map((item) => ({ studentId: item.userId, realName: item.realName || item.userId }))
          : [{ studentId: record.userId, realName: record.userName || record.userId }];
        const id = canonicalReservationSource({
          roomId: record.roomId,
          date: times.start.date,
          startTime: times.start.time,
          endTime: times.end.time,
          studentIds: participants.map((item) => item.studentId),
        });
        let group = groups.get(id);
        if (!group) {
          group = {
            id,
            roomId: record.roomId,
            roomName: record.roomName ?? `房间 ${record.roomId}`,
            date: times.start.date,
            startTime: times.start.time,
            endTime: times.end.time,
            startTimestamp: record.startTime,
            endTimestamp: record.endTime,
            participants,
            signedInMembers: [],
            candidates: [],
          };
          groups.set(id, group);
        }
        if (!group.candidates.some((candidate) => candidate.id === member.id)) {
          group.candidates.push({ ...member, officialReservationId: String(record.id) });
          group.signedInMembers.push(member);
        }
      }
    } catch (error) {
      warnings.push({
        userId: member.id,
        realName: member.realName,
        message: error instanceof Error ? error.message : "预约读取失败",
      });
    }
  }

  const sorted = [...groups.values()].sort((left, right) => left.startTimestamp - right.startTimestamp || left.roomName.localeCompare(right.roomName));
  return { groups: sorted, options: publicTeamDoorGroups(sorted), warnings };
}

async function executeDoorOptions(env: AppEnv, job: OfficialGatewayJob): Promise<TeamDoorOptionsResult> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "开门查询任务缺少用户");
  const teamId = requireString(job.payload.teamId, "teamId", 80);
  const result = await buildTeamDoorOptions(env, job.ownerUserId, teamId);
  return { options: result.options, warnings: result.warnings };
}

async function executeOpenDoor(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "开门任务缺少用户");
  const teamId = requireString(job.payload.teamId, "teamId", 80);
  const optionId = requireString(job.payload.optionId, "optionId", 500);
  const leader = await env.DB.prepare("SELECT real_name, email FROM users WHERE id = ?")
    .bind(job.ownerUserId).first<{ real_name: string | null; email: string }>();
  const result = await buildTeamDoorOptions(env, job.ownerUserId, teamId);
  const option = result.groups.find((candidate) => candidate.id === optionId);
  if (!option) throw new HttpError(409, "TEAM_DOOR_OPTION_EXPIRED", "该预约当前已无法开门，请重新查询");

  const device = resolveSignDevice(env, option.roomId);
  const failures: Array<{ userId: string; message: string }> = [];
  for (const candidate of option.candidates) {
    try {
      const token = await getAccessToken(env, candidate.id);
      const key = await createOfficialQrSignCheckCode(env, token, device.roomId, device.systemMac);
      await submitOfficialSign(env, token, device.roomId, device.systemMac, key);
      await audit(env.DB, {
        actorUserId: job.ownerUserId,
        actorType: "USER",
        action: "TEAM_DOOR_OPENED",
        targetType: "TEAM",
        targetId: teamId,
        result: "SUCCESS",
        metadata: { optionId, roomId: option.roomId, roomName: option.roomName, executorUserId: candidate.id },
      });
      return {
        optionId,
        roomId: option.roomId,
        roomName: option.roomName,
        openedByUserId: candidate.id,
        openedByName: candidate.realName,
        requestedByName: leader?.real_name ?? leader?.email ?? job.ownerUserId,
      };
    } catch (error) {
      failures.push({ userId: candidate.id, message: error instanceof Error ? error.message : "开门失败" });
    }
  }

  await audit(env.DB, {
    actorUserId: job.ownerUserId,
    actorType: "USER",
    action: "TEAM_DOOR_OPENED",
    targetType: "TEAM",
    targetId: teamId,
    result: "FAILED",
    metadata: { optionId, roomId: option.roomId, failures },
  });
  throw new HttpError(502, "TEAM_DOOR_OPEN_FAILED", "所有已签到成员的开门请求均未成功");
}

function directJob(kind: "TEAM_DOOR_OPTIONS_REFRESH" | "TEAM_OPEN_DOOR", ownerUserId: string, payload: Record<string, unknown>): OfficialGatewayJob {
  const now = Date.now();
  return {
    id: "direct", kind, lane: kind === "TEAM_OPEN_DOOR" ? "WRITE" : "READ", ownerUserId, dedupeKey: null,
    payload, status: "RUNNING", priority: 0, attemptCount: 1, maxAttempts: 1, availableAt: now,
    result: null, errorCode: null, errorMessage: null, createdAt: now, startedAt: now, finishedAt: null, updatedAt: now,
  };
}

async function gatewayJobResponse(env: AppEnv, job: OfficialGatewayJob, waitMs: number): Promise<Response> {
  const current = waitMs > 0 ? await env.OFFICIAL_GATEWAY!.waitForJob(job.id, waitMs) : job;
  return json({ ok: true, data: publicGatewayJob(current) }, current.status === "QUEUED" || current.status === "RUNNING" ? 202 : 200);
}

export async function teamDoorOptions(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  await requireTeamLeader(env, leader.id, teamId);
  if (!env.OFFICIAL_GATEWAY) return ok(await executeDoorOptions(env, directJob("TEAM_DOOR_OPTIONS_REFRESH", leader.id, { teamId })));
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "TEAM_DOOR_OPTIONS_REFRESH",
    lane: "READ",
    ownerUserId: leader.id,
    dedupeKey: `team-door-options:${leader.id}:${teamId}`,
    payload: { teamId },
    priority: 10,
    maxAttempts: 1,
  });
  return gatewayJobResponse(env, job, 5000);
}

export async function openTeamDoor(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  await requireTeamLeader(env, leader.id, teamId);
  const body = await readJsonBody<Record<string, unknown>>(request);
  const optionId = requireString(body.optionId, "optionId", 500);
  if (!env.OFFICIAL_GATEWAY) return ok(await executeOpenDoor(env, directJob("TEAM_OPEN_DOOR", leader.id, { teamId, optionId })));
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "TEAM_OPEN_DOOR",
    lane: "WRITE",
    ownerUserId: leader.id,
    dedupeKey: `team-open-door:${leader.id}:${teamId}:${optionId}`,
    payload: { teamId, optionId },
    priority: 1,
    maxAttempts: 1,
  });
  return gatewayJobResponse(env, job, 5000);
}

export function registerTeamDoorGatewayHandlers(env: AppEnv): void {
  env.OFFICIAL_GATEWAY?.registerHandler("TEAM_DOOR_OPTIONS_REFRESH", (job) => executeDoorOptions(env, job));
  env.OFFICIAL_GATEWAY?.registerHandler("TEAM_OPEN_DOOR", (job) => executeOpenDoor(env, job));
}
