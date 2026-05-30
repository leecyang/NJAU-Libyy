import type { AppEnv } from "../config";
import { HttpError, readBoundedJson } from "./http";
import type { Room } from "./validation";

export type OfficialRefreshResult = {
  accessToken: string;
  reflushToken: string;
  expires: number;
};

export type OfficialIdentity = {
  userId: string;
  realName: string;
};

export type OfficialMember = {
  userId: string;
  userName: string;
};

export type OfficialReservationRequest = {
  roomId: number;
  date: string;
  startTime: string;
  endTime: string;
  useDescription: "小组学习";
  members: OfficialMember[];
};

type OfficialError = {
  code?: number;
  msg?: string;
};

function officialUrl(env: AppEnv, path: string): URL {
  return new URL(path, env.LIBYY_API_BASE_URL);
}

function appSecret(env: AppEnv): string {
  if (!env.LIBYY_APP_SECRET) throw new HttpError(503, "OFFICIAL_API_NOT_CONFIGURED", "官方接口密钥尚未配置");
  return env.LIBYY_APP_SECRET;
}

async function officialJson(response: Response): Promise<unknown> {
  try {
    return await readBoundedJson(response);
  } catch {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方接口返回格式异常");
  }
}

function officialFailure(response: Response, body: unknown): HttpError {
  const detail = body && typeof body === "object" ? body as OfficialError : {};
  if (detail.code === 2003) return new HttpError(401, "OFFICIAL_REAUTH_REQUIRED", "官方登录已失效，请重新绑定凭证");
  if (detail.code === 2004) return new HttpError(400, "OFFICIAL_TOKEN_INVALID", "凭证格式错误，请重新复制");
  return new HttpError(502, "OFFICIAL_REQUEST_FAILED", `官方接口请求失败 (${response.status})`);
}

export async function refreshOfficialToken(env: AppEnv, reflushToken: string): Promise<OfficialRefreshResult> {
  const url = officialUrl(env, "/api/oauth/v1/reflushToken");
  url.searchParams.set("reflushToken", reflushToken);
  url.searchParams.set("appId", env.LIBYY_APP_ID);
  url.searchParams.set("appSecret", appSecret(env));

  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: reflushToken, accept: "application/json;charset=UTF-8" },
  });
  const body = await officialJson(response);
  if (!response.ok) throw officialFailure(response, body);
  if (!body || typeof body !== "object") throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方刷新响应格式异常");

  const result = body as Partial<OfficialRefreshResult>;
  if (!result.accessToken || !result.reflushToken || !Number.isFinite(result.expires)) {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方刷新响应缺少必要字段");
  }
  return { accessToken: result.accessToken, reflushToken: result.reflushToken, expires: Number(result.expires) };
}

export async function fetchOfficialIdentity(env: AppEnv, accessToken: string): Promise<OfficialIdentity> {
  const url = officialUrl(env, "/api/oauth/v1/user");
  url.searchParams.set("accessToken", accessToken);
  url.searchParams.set("appId", env.LIBYY_APP_ID);
  url.searchParams.set("appSecret", appSecret(env));

  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: accessToken, accept: "application/json" },
  });
  const body = await officialJson(response);
  if (!response.ok) throw officialFailure(response, body);
  if (!body || typeof body !== "object") throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方身份响应格式异常");

  const identity = body as Partial<OfficialIdentity>;
  if (!identity.userId || !identity.realName) {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方身份响应缺少必要字段");
  }
  return { userId: identity.userId, realName: identity.realName };
}

export async function fetchOfficialRooms(env: AppEnv, accessToken: string, date: string): Promise<Room[]> {
  const url = officialUrl(env, "/api/studyroom/v1/room/mRooms");
  url.searchParams.set("roomType", "");
  url.searchParams.set("date", date);
  const response = await fetch(url, { headers: { authorization: accessToken, accept: "application/json" } });
  const body = await officialJson(response);
  if (!response.ok) throw officialFailure(response, body);
  if (!Array.isArray(body)) throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方房间响应格式异常");

  const rooms: Room[] = [];
  for (const group of body) {
    if (!group || typeof group !== "object" || !Array.isArray((group as { rooms?: unknown }).rooms)) continue;
    for (const raw of (group as { rooms: unknown[] }).rooms) {
      if (!raw || typeof raw !== "object") continue;
      const room = raw as Partial<Room>;
      if (typeof room.id !== "number" || typeof room.name !== "string") continue;
      rooms.push({
        id: room.id,
        name: room.name,
        roomLocation: room.roomLocation,
        minReservationNum: Number(room.minReservationNum ?? 1),
        maxNum: Number(room.maxNum ?? 0),
        startTime: room.startTime,
        endTime: room.endTime,
        reservationMinTime: room.reservationMinTime,
        reservationMaxTime: room.reservationMaxTime,
        dateTimeSlicesList: room.dateTimeSlicesList,
      });
    }
  }
  return rooms;
}

export async function submitOfficialReservation(
  env: AppEnv,
  accessToken: string,
  request: OfficialReservationRequest,
): Promise<unknown> {
  const response = await fetch(officialUrl(env, "/api/studyroom/v1/reservation/accept"), {
    method: "POST",
    headers: { authorization: accessToken, accept: "application/json", "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify(request),
  });
  const body = await officialJson(response);
  if (!response.ok) throw officialFailure(response, body);
  return body;
}

export async function searchOfficialUsers(env: AppEnv, accessToken: string, query: string): Promise<unknown> {
  const url = officialUrl(env, "/api/studyroom/v1/user/pageUser");
  url.searchParams.set("page", "1");
  url.searchParams.set("size", "10");
  url.searchParams.set("userName", query);
  const response = await fetch(url, { headers: { authorization: accessToken, accept: "application/json" } });
  const body = await officialJson(response);
  if (!response.ok) throw officialFailure(response, body);
  return body;
}

