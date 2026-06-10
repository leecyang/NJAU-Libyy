import type { AppEnv } from "../config";
import { HttpError, readBoundedJson, readBoundedText } from "./http";
import type { Room } from "./validation";

export type OfficialRefreshResult = {
  accessToken: string;
  reflushToken: string;
  expires: number;
};

export type OfficialIdentity = {
  id?: number;
  userId: string;
  realName: string;
  mobile?: string;
  totalScore?: number;
};

export type OfficialUserScore = {
  userId: string;
  realName: string;
  totalScore: number;
};

export type OfficialMember = {
  userId: string;
  userName: string;
};

export type OfficialReservationRequest = {
  ownerStudentId: string;
  mobile: string;
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

type OfficialProxyError = {
  error?: {
    code?: string;
  };
};

type OfficialProxyResponse = {
  ok?: boolean;
  status?: number;
  headers?: Record<string, unknown>;
  body?: string;
  contentType?: string;
};

type OfficialOperation =
  | "refresh-token"
  | "identity"
  | "rooms"
  | "room-detail"
  | "reservation-dates"
  | "room-policy"
  | "reservation-members"
  | "reservation"
  | "reservation-history"
  | "reservation-accept"
  | "reservation-cancel"
  | "reservation-sign"
  | "reservation-signout"
  | "sign-key"
  | "user-search"
  | "user-score";

type OfficialResponseDiagnostic = {
  operation: OfficialOperation;
  status: number;
  contentType: string | null;
  contentLength: string | null;
  bodyKind: "empty" | "html-like" | "json-like" | "text-like";
  htmlMarker: "network-restricted" | "unsupported-get" | "unsupported-post" | "thymeleaf-error" | "cloudflare-challenge" | "html-other" | null;
  bodyPrefixBytes: number;
  bodyPrefixSha256: string;
  bodyPrefixTruncated: boolean;
  redirected: boolean;
  responsePath: string;
};

const OFFICIAL_BROWSER_HEADERS = {
  origin: "https://libyy.njau.edu.cn",
  referer: "https://libyy.njau.edu.cn/student/studentIndex",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const OFFICIAL_PROXY_TIMEOUT_MS = 30_000;
const OFFICIAL_WORKER_FETCH_TIMEOUT_MS = 18_000;

function officialUrl(env: AppEnv, path: string): URL {
  return new URL(path, env.LIBYY_API_BASE_URL);
}

function proxyEndpoint(env: AppEnv): URL {
  if (!env.NJAU_PROXY_ENDPOINT || !env.NJAU_PROXY_TOKEN) {
    throw new HttpError(503, "OFFICIAL_PROXY_NOT_CONFIGURED", "校园网代理尚未配置");
  }
  const url = new URL(env.NJAU_PROXY_ENDPOINT);
  if (url.protocol !== "https:") {
    throw new HttpError(503, "OFFICIAL_PROXY_NOT_CONFIGURED", "校园网代理配置错误");
  }
  return url;
}

function officialNetworkMode(env: AppEnv): "tailscale-direct" | "http-proxy" {
  if (env.OFFICIAL_NETWORK_MODE) return env.OFFICIAL_NETWORK_MODE;
  return env.NJAU_PROXY_ENDPOINT && env.NJAU_PROXY_TOKEN ? "http-proxy" : "tailscale-direct";
}

function officialHeaders(authorization: string, accept = "application/json"): Record<string, string> {
  return { ...OFFICIAL_BROWSER_HEADERS, authorization, accept };
}

function appSecret(env: AppEnv): string {
  if (!env.LIBYY_APP_SECRET) throw new HttpError(503, "OFFICIAL_API_NOT_CONFIGURED", "官方接口密钥尚未配置");
  return env.LIBYY_APP_SECRET;
}

async function readDiagnosticPrefix(response: Response, maxBytes = 4096): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    chunks.push(value.byteLength > remaining ? value.slice(0, remaining) : value);
    total += Math.min(value.byteLength, remaining);
    if (value.byteLength > remaining) {
      truncated = true;
      break;
    }
  }

  if (total === maxBytes) {
    truncated = true;
    await reader.cancel();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function bodyKind(bytes: Uint8Array): OfficialResponseDiagnostic["bodyKind"] {
  const text = new TextDecoder().decode(bytes).trimStart().toLowerCase();
  if (!text) return "empty";
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<")) return "html-like";
  if (text.startsWith("{") || text.startsWith("[")) return "json-like";
  return "text-like";
}

function htmlMarker(bytes: Uint8Array): OfficialResponseDiagnostic["htmlMarker"] {
  const text = new TextDecoder().decode(bytes).toLowerCase();
  if (!text.trimStart().startsWith("<")) return null;
  if (text.includes("校园vpn") || text.includes("安全加固") || text.includes("网站维护")) return "network-restricted";
  if (text.includes("request method &#39;get&#39; not supported") || text.includes("request method 'get' not supported")) return "unsupported-get";
  if (text.includes("request method &#39;post&#39; not supported") || text.includes("request method 'post' not supported")) return "unsupported-post";
  if (text.includes("templateinputexception")) return "thymeleaf-error";
  if (text.includes("cloudflare") || text.includes("cf-chl-")) return "cloudflare-challenge";
  return "html-other";
}

async function digestPrefix(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function responsePath(response: Response): string {
  try {
    return new URL(response.url).pathname;
  } catch {
    return "";
  }
}

async function officialResponseDiagnostic(response: Response, operation: OfficialOperation): Promise<OfficialResponseDiagnostic> {
  const { bytes, truncated } = await readDiagnosticPrefix(response);
  return {
    operation,
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    bodyKind: bodyKind(bytes),
    htmlMarker: htmlMarker(bytes),
    bodyPrefixBytes: bytes.byteLength,
    bodyPrefixSha256: await digestPrefix(bytes),
    bodyPrefixTruncated: truncated,
    redirected: response.redirected,
    responsePath: responsePath(response),
  };
}

function proxyFailure(response: Response, body: unknown, operation: OfficialOperation): HttpError {
  const detail = body && typeof body === "object" ? body as OfficialProxyError : {};
  console.error(JSON.stringify({
    level: "error",
    event: "official_proxy_request_failed",
    operation,
    status: response.status,
    errorCode: detail.error?.code ?? null,
  }));
  return new HttpError(502, "OFFICIAL_PROXY_REQUEST_FAILED", `校园网代理请求失败 (${response.status})`);
}

function proxyResponseHeaders(result: OfficialProxyResponse): Headers {
  const headers = new Headers();
  const contentType = typeof result.contentType === "string"
    ? result.contentType
    : typeof result.headers?.["content-type"] === "string"
      ? result.headers["content-type"]
      : "";
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

function headerRecord(init?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

const OFFICIAL_WRITE_OPERATIONS = new Set<OfficialOperation>([
  "refresh-token",
  "reservation",
  "reservation-accept",
  "reservation-cancel",
  "reservation-sign",
  "reservation-signout",
  "sign-key",
]);

function requestFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function officialRequestKey(url: URL, operation: OfficialOperation, init: RequestInit): string {
  const safeUrl = new URL(url);
  safeUrl.searchParams.delete("accessToken");
  safeUrl.searchParams.delete("appSecret");
  safeUrl.searchParams.delete("reflushToken");
  const headers = new Headers(init.headers);
  const authorization = headers.get("authorization") ?? "";
  const body = typeof init.body === "string" ? init.body : "";
  return `${operation}:${init.method ?? "GET"}:${safeUrl.pathname}?${safeUrl.searchParams.toString()}:auth=${requestFingerprint(authorization)}:body=${requestFingerprint(body)}`;
}

async function rawOfficialFetch(
  env: AppEnv,
  url: URL,
  operation: OfficialOperation,
  init: RequestInit = {},
): Promise<Response> {
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new Error("Official proxy only supports string request bodies");
  }

  if (officialNetworkMode(env) === "tailscale-direct") {
    try {
      const signal = AbortSignal.timeout(OFFICIAL_PROXY_TIMEOUT_MS);
      return await fetch(url, { ...init, signal });
    } catch (error) {
      const code = error instanceof Error && error.name === "TimeoutError" ? "OFFICIAL_API_TIMEOUT" : "OFFICIAL_API_UNAVAILABLE";
      throw new HttpError(502, code, code === "OFFICIAL_API_TIMEOUT" ? "官方接口请求超时" : "官方接口暂时不可用");
    }
  }

  let response: Response;
  try {
    const signal = AbortSignal.timeout(OFFICIAL_WORKER_FETCH_TIMEOUT_MS);
    response = await fetch(proxyEndpoint(env), {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${env.NJAU_PROXY_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        url: url.href,
        method: init.method ?? "GET",
        headers: headerRecord(init.headers),
        ...(init.body === undefined ? {} : { body: init.body }),
        timeoutMs: OFFICIAL_PROXY_TIMEOUT_MS,
      }),
    });
  } catch (error) {
    const code = error instanceof Error && error.name === "TimeoutError" ? "OFFICIAL_PROXY_TIMEOUT" : "OFFICIAL_PROXY_UNAVAILABLE";
    throw new HttpError(502, code, code === "OFFICIAL_PROXY_TIMEOUT" ? "校园网代理请求超时" : "校园网代理暂时不可用");
  }

  let body: unknown;
  try {
    body = await readBoundedJson(response, 524_288);
  } catch {
    throw new HttpError(502, "OFFICIAL_PROXY_INVALID_RESPONSE", "校园网代理返回格式异常");
  }
  if (!response.ok) throw proxyFailure(response, body, operation);
  if (!body || typeof body !== "object") {
    throw new HttpError(502, "OFFICIAL_PROXY_INVALID_RESPONSE", "校园网代理返回格式异常");
  }

  const result = body as OfficialProxyResponse;
  if (
    result.ok !== true ||
    !Number.isInteger(result.status) ||
    Number(result.status) < 200 ||
    Number(result.status) > 599 ||
    typeof result.body !== "string"
  ) {
    throw new HttpError(502, "OFFICIAL_PROXY_INVALID_RESPONSE", "校园网代理返回格式异常");
  }
  return new Response(result.body, {
    status: result.status,
    headers: proxyResponseHeaders(result),
  });
}

async function officialFetch(
  env: AppEnv,
  url: URL,
  operation: OfficialOperation,
  init: RequestInit = {},
): Promise<Response> {
  const execute = () => rawOfficialFetch(env, url, operation, init);
  if (!env.OFFICIAL_GATEWAY) return execute();
  return env.OFFICIAL_GATEWAY.runOfficialRequest(
    officialRequestKey(url, operation, init),
    OFFICIAL_WRITE_OPERATIONS.has(operation) ? "WRITE" : "READ",
    execute,
  );
}

async function officialJson(response: Response, operation: OfficialOperation): Promise<unknown> {
  const diagnosticResponse = response.clone();
  try {
    return await readBoundedJson(response);
  } catch {
    const diagnostic = await officialResponseDiagnostic(diagnosticResponse, operation);
    console.error(JSON.stringify({
      level: "error",
      event: "official_invalid_response",
      ...diagnostic,
    }));
    if (diagnostic.htmlMarker === "network-restricted") {
      throw new HttpError(502, "OFFICIAL_NETWORK_RESTRICTED", "官方接口当前仅允许校园网或校园 VPN 访问，云端服务无法直连");
    }
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方接口返回格式异常");
  }
}

async function officialText(response: Response, operation: OfficialOperation): Promise<string> {
  try {
    return await readBoundedText(response, 262_144);
  } catch {
    console.error(JSON.stringify({ level: "error", event: "official_text_response_failed", operation }));
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方接口返回格式异常");
  }
}

function officialFailure(response: Response, body: unknown): HttpError {
  const detail = body && typeof body === "object" ? body as OfficialError : {};
  if (detail.code === 2003 || detail.code === 2008) {
    return new HttpError(401, "OFFICIAL_REAUTH_REQUIRED", "官方登录已失效，请重新绑定凭证");
  }
  if (detail.code === 2004) return new HttpError(400, "OFFICIAL_TOKEN_INVALID", "凭证格式错误，请重新复制");
  const officialCode = Number.isInteger(detail.code) ? detail.code : null;
  console.error(JSON.stringify({
    level: "error",
    event: "official_request_failed",
    status: response.status,
    officialCode,
  }));
  const suffix = officialCode === null ? "" : `, 官方错误码: ${officialCode}`;
  return new HttpError(502, "OFFICIAL_REQUEST_FAILED", `官方接口请求失败 (${response.status}${suffix})`);
}

export async function refreshOfficialToken(env: AppEnv, reflushToken: string): Promise<OfficialRefreshResult> {
  const url = officialUrl(env, "/api/oauth/v1/reflushToken");
  url.searchParams.set("reflushToken", reflushToken);
  url.searchParams.set("appId", env.LIBYY_APP_ID);
  url.searchParams.set("appSecret", appSecret(env));

  const response = await officialFetch(env, url, "refresh-token", {
    method: "POST",
    headers: officialHeaders(reflushToken, "application/json;charset=UTF-8"),
  });
  const body = await officialJson(response, "refresh-token");
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

  const response = await officialFetch(env, url, "identity", {
    method: "POST",
    headers: officialHeaders(accessToken),
  });
  const body = await officialJson(response, "identity");
  if (!response.ok) throw officialFailure(response, body);
  if (!body || typeof body !== "object") throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方身份响应格式异常");

  const identity = body as Partial<OfficialIdentity>;
  if (!identity.userId || !identity.realName) {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方身份响应缺少必要字段");
  }
  return {
    id: typeof identity.id === "number" ? identity.id : undefined,
    userId: identity.userId,
    realName: identity.realName,
    mobile: typeof identity.mobile === "string" ? identity.mobile : undefined,
  };
}

export async function fetchOfficialRooms(env: AppEnv, accessToken: string, date: string): Promise<Room[]> {
  const url = officialUrl(env, "/api/studyroom/v1/room/mRooms");
  url.searchParams.set("roomType", "");
  url.searchParams.set("date", date);
  const response = await officialFetch(env, url, "rooms", { headers: officialHeaders(accessToken) });
  const body = await officialJson(response, "rooms");
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
        status: typeof room.status === "number" ? room.status : undefined,
        remark: typeof room.remark === "string" ? room.remark : undefined,
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

export type OfficialReservationRecord = {
  id: number;
  roomId: number;
  userId: string;
  userName?: string;
  reservationStatus: number;
  startTime: number;
  endTime: number;
  signInTime?: number | null;
  signOutTime?: number | null;
  minSignTime?: number | null;
  maxSignTime?: number | null;
  roomName?: string;
  members?: unknown[];
};

type OfficialReservationPage = {
  records?: unknown[];
};

type OfficialUserPage = {
  records?: unknown[];
};

function parseRoom(raw: unknown): Room {
  if (!raw || typeof raw !== "object") throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方房间详情响应格式异常");
  const room = raw as Partial<Room>;
  if (typeof room.id !== "number" || typeof room.name !== "string") {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方房间详情响应缺少必要字段");
  }
  return {
    id: room.id,
    name: room.name,
    roomLocation: room.roomLocation,
    status: typeof room.status === "number" ? room.status : undefined,
    remark: typeof room.remark === "string" ? room.remark : undefined,
    minReservationNum: Number(room.minReservationNum ?? 1),
    maxNum: Number(room.maxNum ?? 0),
    startTime: room.startTime,
    endTime: room.endTime,
    reservationMinTime: room.reservationMinTime,
    reservationMaxTime: room.reservationMaxTime,
    dateTimeSlicesList: Array.isArray(room.dateTimeSlicesList) ? room.dateTimeSlicesList : undefined,
  };
}

function parseReservationRecord(raw: unknown): OfficialReservationRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<OfficialReservationRecord>;
  if (
    typeof row.id !== "number" ||
    typeof row.roomId !== "number" ||
    typeof row.userId !== "string" ||
    typeof row.reservationStatus !== "number" ||
    typeof row.startTime !== "number" ||
    typeof row.endTime !== "number"
  ) return null;
  return row as OfficialReservationRecord;
}

export async function fetchOfficialRoomDetail(env: AppEnv, accessToken: string, roomId: number, date: string): Promise<Room> {
  const url = officialUrl(env, "/api/studyroom/v1/room/reservation");
  url.searchParams.set("roomId", String(roomId));
  url.searchParams.set("date", date);
  const response = await officialFetch(env, url, "room-detail", { headers: officialHeaders(accessToken) });
  const body = await officialJson(response, "room-detail");
  if (!response.ok) throw officialFailure(response, body);
  return parseRoom(body);
}

export async function fetchOfficialReservationDates(env: AppEnv, accessToken: string): Promise<string[]> {
  const response = await officialFetch(env, officialUrl(env, "/api/studyroom/v1/room/reservationDate"), "reservation-dates", {
    headers: officialHeaders(accessToken),
  });
  const body = await officialJson(response, "reservation-dates");
  if (!response.ok) throw officialFailure(response, body);
  if (!Array.isArray(body) || body.some((value) => typeof value !== "string")) {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方预约日期响应格式异常");
  }
  return body;
}

export async function verifyOfficialRoomPolicy(env: AppEnv, accessToken: string, userId: string, roomId: number, memberIds: string[] = []): Promise<boolean> {
  const url = officialUrl(env, "/api/studyroom/v1/room/verifyRoomPloy");
  url.searchParams.set("userId", userId);
  if (memberIds.length) url.searchParams.set("memberIds", memberIds.join(","));
  url.searchParams.set("roomId", String(roomId));
  const response = await officialFetch(env, url, "room-policy", { headers: officialHeaders(accessToken) });
  const body = await officialJson(response, "room-policy");
  if (!response.ok) throw officialFailure(response, body);
  if (typeof body !== "boolean") throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方房间规则响应格式异常");
  return body;
}

export async function judgeOfficialReservationUsers(
  env: AppEnv,
  accessToken: string,
  userId: string,
  memberIds: string[],
  date: string,
  startTime: string,
): Promise<void> {
  const url = officialUrl(env, "/api/studyroom/v1/reservation/reservationUserJudge");
  url.searchParams.set("userId", userId);
  url.searchParams.set("memberIds", memberIds.join(","));
  url.searchParams.set("startTime", `${date} ${startTime}:00`);
  const response = await officialFetch(env, url, "reservation-members", { headers: officialHeaders(accessToken) });
  const body = await officialText(response, "reservation-members");
  if (!response.ok) throw officialFailure(response, body);
}

export async function submitOfficialReservation(
  env: AppEnv,
  accessToken: string,
  request: OfficialReservationRequest,
): Promise<unknown> {
  const url = officialUrl(env, "/api/studyroom/v1.1/reservation/reservation");
  url.searchParams.set("userId", request.ownerStudentId);
  url.searchParams.set("memberIds", request.members.map((member) => member.userId).join(","));
  url.searchParams.set("roomId", String(request.roomId));
  url.searchParams.set("startTime", `${request.date} ${request.startTime}:00`);
  url.searchParams.set("endTime", `${request.date} ${request.endTime}:00`);
  url.searchParams.set("dictId", request.members.length ? "7" : "2");
  url.searchParams.set("behaviorMode", request.members.length ? "1" : "4");
  url.searchParams.set("mobile", request.mobile);
  url.searchParams.set("remark", "");
  url.searchParams.set("filePath", "");
  const response = await officialFetch(env, url, "reservation", {
    method: "POST",
    headers: officialHeaders(accessToken),
  });
  const text = await officialText(response, "reservation");
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : "";
  } catch {
    // Some official operations intentionally return plain text.
  }
  if (!response.ok) throw officialFailure(response, body);
  return body;
}

export async function fetchOfficialReservationHistory(
  env: AppEnv,
  accessToken: string,
  userId: string,
): Promise<OfficialReservationRecord[]> {
  const url = officialUrl(env, "/api/studyroom/v1/reservation/pageByUserId");
  url.searchParams.set("page", "1");
  url.searchParams.set("size", "100");
  const response = await officialFetch(env, url, "reservation-history", {
    method: "POST",
    headers: { ...officialHeaders(accessToken), "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ userId }),
  });
  const body = await officialJson(response, "reservation-history");
  if (!response.ok) throw officialFailure(response, body);
  if (!body || typeof body !== "object" || !Array.isArray((body as OfficialReservationPage).records)) {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方预约历史响应格式异常");
  }
  return (body as OfficialReservationPage).records!.map(parseReservationRecord).filter((row): row is OfficialReservationRecord => Boolean(row));
}

async function officialEmptyPost(env: AppEnv, accessToken: string, operation: OfficialOperation, path: string, params: Record<string, string>): Promise<void> {
  const url = officialUrl(env, path);
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));
  const response = await officialFetch(env, url, operation, { method: "POST", headers: officialHeaders(accessToken) });
  const body = await officialText(response, operation);
  if (!response.ok) throw officialFailure(response, body);
}

export async function cancelOfficialReservation(env: AppEnv, accessToken: string, reservationId: string): Promise<void> {
  return officialEmptyPost(env, accessToken, "reservation-cancel", "/api/studyroom/v1/reservation/cancelReservation", {
    reservationId,
    cancelType: "1",
  });
}

export async function acceptOfficialReservation(env: AppEnv, accessToken: string, reservationId: string): Promise<void> {
  return officialEmptyPost(env, accessToken, "reservation-accept", "/api/studyroom/v1/reservation/accept", {
    reservationId,
    status: "1",
  });
}

export async function submitOfficialSign(env: AppEnv, accessToken: string, roomId: string, systemMac: string, qrSignCheckCode: string): Promise<void> {
  const response = await officialFetch(env, officialUrl(env, "/api/studyroom/v1/sign"), "reservation-sign", {
    method: "POST",
    headers: { ...officialHeaders(accessToken), "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ systemMac, roomId, qrSignCheckCode }),
  });
  const body = await officialJson(response, "reservation-sign");
  if (!response.ok) throw officialFailure(response, body);
  if (!body || typeof body !== "object" || (body as { executionResult?: unknown }).executionResult !== true) {
    throw new HttpError(409, "OFFICIAL_SIGN_REJECTED", "官方签到未成功");
  }
}

export async function signOutOfficialReservation(env: AppEnv, accessToken: string, userId: string, roomId: string): Promise<void> {
  return officialEmptyPost(env, accessToken, "reservation-signout", "/api/studyroom/v1/reservation/signOut", {
    userId,
    roomId,
  });
}

export async function createOfficialQrSignCheckCode(env: AppEnv, accessToken: string, roomId: string, systemMac: string): Promise<string> {
  const url = officialUrl(env, "/api/studyroom/v1/reservation/createQrSignCheckCode");
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("systemMac", systemMac);
  const response = await officialFetch(env, url, "sign-key", { headers: officialHeaders(accessToken) });
  const text = await officialText(response, "sign-key");
  if (!response.ok) throw officialFailure(response, text);
  let key = text;
  try {
    const body = JSON.parse(text) as unknown;
    key = typeof body === "string" ? body : "";
  } catch {
    // Plain text keys are supported.
  }
  if (!key || key.length > 2048) throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方签到 Key 响应格式异常");
  return key;
}

export async function searchOfficialUsers(env: AppEnv, accessToken: string, query: string): Promise<OfficialIdentity> {
  const url = officialUrl(env, "/api/studyroom/v1/user/pageUser");
  url.searchParams.set("param", query);
  url.searchParams.set("page", "1");
  url.searchParams.set("size", "10");
  const response = await officialFetch(env, url, "user-search", { headers: officialHeaders(accessToken, "application/json;charset=UTF-8") });
  const body = await officialJson(response, "user-search");
  if (!response.ok) throw officialFailure(response, body);
  if (!body || typeof body !== "object" || !Array.isArray((body as OfficialUserPage).records)) {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方用户搜索响应格式异常");
  }
  const users = (body as OfficialUserPage).records!
    .map((raw) => raw && typeof raw === "object" ? raw as Partial<OfficialIdentity> : null)
    .filter((user): user is Partial<OfficialIdentity> => Boolean(user?.userId && user.realName));
  const user = users.find((candidate) => candidate.userId === query) ?? (users.length === 1 ? users[0] : null);
  if (!user?.userId || !user.realName) throw new HttpError(404, "OFFICIAL_USER_NOT_FOUND", "未找到该学号");
  return {
    id: typeof user.id === "number" ? user.id : undefined,
    userId: user.userId,
    realName: user.realName,
    mobile: typeof user.mobile === "string" ? user.mobile : undefined,
    totalScore: typeof (user as Record<string, unknown>).totalScore === "number" ? (user as Record<string, unknown>).totalScore as number : undefined,
  };
}

export async function fetchOfficialUserScore(
  env: AppEnv,
  accessToken: string,
  userId: string,
): Promise<OfficialUserScore> {
  const url = officialUrl(env, `/api/studyroom/v1/user/${encodeURIComponent(userId)}`);
  const response = await officialFetch(env, url, "user-score", { headers: officialHeaders(accessToken, "application/json;charset=UTF-8") });
  const body = await officialJson(response, "user-score");
  if (!response.ok) throw officialFailure(response, body);
  if (!body || typeof body !== "object") throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方用户积分响应格式异常");
  const data = body as Record<string, unknown>;
  if (typeof data.totalScore !== "number" || typeof data.userId !== "string" || typeof data.realName !== "string") {
    throw new HttpError(502, "OFFICIAL_INVALID_RESPONSE", "官方用户积分响应缺少必要字段");
  }
  return {
    userId: data.userId as string,
    realName: data.realName as string,
    totalScore: data.totalScore as number,
  };
}
