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

type OfficialOperation = "refresh-token" | "identity" | "rooms" | "reservation" | "user-search";

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

async function officialFetch(
  env: AppEnv,
  url: URL,
  operation: OfficialOperation,
  init: RequestInit = {},
): Promise<Response> {
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new Error("Official proxy only supports string request bodies");
  }

  let response: Response;
  try {
    response = await fetch(proxyEndpoint(env), {
      method: "POST",
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
  } catch {
    throw new HttpError(502, "OFFICIAL_PROXY_UNAVAILABLE", "校园网代理暂时不可用");
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

function officialFailure(response: Response, body: unknown): HttpError {
  const detail = body && typeof body === "object" ? body as OfficialError : {};
  if (detail.code === 2003 || detail.code === 2008) {
    return new HttpError(401, "OFFICIAL_REAUTH_REQUIRED", "官方登录已失效，请重新绑定凭证");
  }
  if (detail.code === 2004) return new HttpError(400, "OFFICIAL_TOKEN_INVALID", "凭证格式错误，请重新复制");
  return new HttpError(502, "OFFICIAL_REQUEST_FAILED", `官方接口请求失败 (${response.status})`);
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
  return { userId: identity.userId, realName: identity.realName };
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
  const response = await officialFetch(env, officialUrl(env, "/api/studyroom/v1/reservation/accept"), "reservation", {
    method: "POST",
    headers: { ...officialHeaders(accessToken), "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify(request),
  });
  const body = await officialJson(response, "reservation");
  if (!response.ok) throw officialFailure(response, body);
  return body;
}

export async function searchOfficialUsers(env: AppEnv, accessToken: string, query: string): Promise<unknown> {
  const url = officialUrl(env, "/api/studyroom/v1/user/pageUser");
  url.searchParams.set("page", "1");
  url.searchParams.set("size", "10");
  url.searchParams.set("userName", query);
  const response = await officialFetch(env, url, "user-search", { headers: officialHeaders(accessToken) });
  const body = await officialJson(response, "user-search");
  if (!response.ok) throw officialFailure(response, body);
  return body;
}
