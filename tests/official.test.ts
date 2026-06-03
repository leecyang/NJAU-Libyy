import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config";
import {
  cancelOfficialReservation,
  createOfficialQrSignCheckCode,
  fetchOfficialIdentity,
  fetchOfficialReservationHistory,
  fetchOfficialRooms,
  refreshOfficialToken,
  searchOfficialUsers,
  signOutOfficialReservation,
  submitOfficialSign,
  submitOfficialReservation,
} from "../src/lib/official";

const env = {
  LIBYY_API_BASE_URL: "https://libyy.njau.edu.cn",
  LIBYY_APP_ID: "app-id",
  LIBYY_APP_SECRET: "app-secret",
  NJAU_PROXY_ENDPOINT: "https://proxy.example/proxy/fetch",
  NJAU_PROXY_TOKEN: "proxy-token",
} as unknown as AppEnv;

function proxyResponse(status: number, body: string, contentType = "application/json"): Response {
  return new Response(JSON.stringify({
    ok: true,
    status,
    headers: { "content-type": contentType },
    body,
    contentType,
  }), { headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("official API adapter", () => {
  it("refreshes a token with the browser request headers required by the official API", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(proxyResponse(200, JSON.stringify({
      accessToken: "new-access-token",
      reflushToken: "new-reflush-token",
      expires: 7200,
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshOfficialToken(env, "old-reflush-token")).resolves.toEqual({
      accessToken: "new-access-token",
      reflushToken: "new-reflush-token",
      expires: 7200,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://proxy.example/proxy/fetch");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        accept: "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://libyy.njau.edu.cn/api/oauth/v1/reflushToken?reflushToken=old-reflush-token&appId=app-id&appSecret=app-secret",
      method: "POST",
      headers: {
        accept: "application/json;charset=UTF-8",
        authorization: "old-reflush-token",
        origin: "https://libyy.njau.edu.cn",
        referer: "https://libyy.njau.edu.cn/student/studentIndex",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeoutMs: 30000,
    });
  });

  it("routes every official HTTP operation through the campus proxy", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(proxyResponse(200, JSON.stringify({ userId: "student-id", realName: "Student" })))
      .mockResolvedValueOnce(proxyResponse(200, "[]"))
      .mockResolvedValueOnce(proxyResponse(200, JSON.stringify({ accepted: true })))
      .mockResolvedValueOnce(proxyResponse(200, JSON.stringify({
        records: [{ userId: "student-id", realName: "Student" }],
      })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchOfficialIdentity(env, "access-token");
    await fetchOfficialRooms(env, "access-token", "2026-06-02");
    await submitOfficialReservation(env, "access-token", {
      ownerStudentId: "student-id",
      mobile: "13000000000",
      roomId: 1,
      date: "2026-06-02",
      startTime: "10:00",
      endTime: "11:00",
      useDescription: "小组学习",
      members: [],
    });
    await searchOfficialUsers(env, "access-token", "student-id");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://proxy.example/proxy/fetch",
      "https://proxy.example/proxy/fetch",
      "https://proxy.example/proxy/fetch",
      "https://proxy.example/proxy/fetch",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => new URL(JSON.parse(String(init?.body)).url).pathname)).toEqual([
      "/api/oauth/v1/user",
      "/api/studyroom/v1/room/mRooms",
      "/api/studyroom/v1.1/reservation/reservation",
      "/api/studyroom/v1/user/pageUser",
    ]);
  });

  it("searches official users with the browser-confirmed pageUser query", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(proxyResponse(200, JSON.stringify({
      records: [
        { id: 12, userId: "other-id", realName: "Other" },
        { id: 34, userId: "student-id", realName: "Student", mobile: "13000000000" },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchOfficialUsers(env, "access-token", "student-id")).resolves.toEqual({
      id: 34,
      userId: "student-id",
      realName: "Student",
      mobile: "13000000000",
    });

    const proxyPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const url = new URL(proxyPayload.url);
    expect(url.pathname).toBe("/api/studyroom/v1/user/pageUser");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      param: "student-id",
      page: "1",
      size: "10",
    });
  });

  it("uses the browser-confirmed reservation query shape", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(proxyResponse(200, JSON.stringify("预约成功")));
    vi.stubGlobal("fetch", fetchMock);

    await submitOfficialReservation(env, "access-token", {
      ownerStudentId: "student-id",
      mobile: "13000000000",
      roomId: 21,
      date: "2026-06-02",
      startTime: "13:00",
      endTime: "14:00",
      useDescription: "小组学习",
      members: [],
    });

    const proxyPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const url = new URL(proxyPayload.url);
    expect(url.pathname).toBe("/api/studyroom/v1.1/reservation/reservation");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      userId: "student-id",
      memberIds: "",
      roomId: "21",
      startTime: "2026-06-02 13:00:00",
      endTime: "2026-06-02 14:00:00",
      dictId: "2",
      behaviorMode: "4",
      mobile: "13000000000",
      remark: "",
      filePath: "",
    });
  });

  it("uses the browser-confirmed multi-member reservation query shape", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(proxyResponse(200, JSON.stringify("预约已经提交，请等待被约人同意")));
    vi.stubGlobal("fetch", fetchMock);

    await submitOfficialReservation(env, "access-token", {
      ownerStudentId: "student-id",
      mobile: "13000000000",
      roomId: 20,
      date: "2026-06-02",
      startTime: "14:00",
      endTime: "15:00",
      useDescription: "小组学习",
      members: [{ userId: "member-id", userName: "Member" }],
    });

    const proxyPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const url = new URL(proxyPayload.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      userId: "student-id",
      memberIds: "member-id",
      roomId: "20",
      startTime: "2026-06-02 14:00:00",
      endTime: "2026-06-02 15:00:00",
      dictId: "7",
      behaviorMode: "1",
      mobile: "13000000000",
      remark: "",
      filePath: "",
    });
  });

  it("supports history, cancellation, signout and short-lived sign keys", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(proxyResponse(200, JSON.stringify({ records: [] })))
      .mockResolvedValueOnce(proxyResponse(200, "", "text/plain"))
      .mockResolvedValueOnce(proxyResponse(200, "", "text/plain"))
      .mockResolvedValueOnce(proxyResponse(200, JSON.stringify("short-lived-key")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOfficialReservationHistory(env, "access-token", "student-id")).resolves.toEqual([]);
    await cancelOfficialReservation(env, "access-token", "18651");
    await signOutOfficialReservation(env, "access-token", "student-id", "23");
    await expect(createOfficialQrSignCheckCode(env, "access-token", "23", "authorized-mac")).resolves.toBe("short-lived-key");

    expect(fetchMock.mock.calls.map(([, init]) => new URL(JSON.parse(String(init?.body)).url).pathname)).toEqual([
      "/api/studyroom/v1/reservation/pageByUserId",
      "/api/studyroom/v1/reservation/cancelReservation",
      "/api/studyroom/v1/reservation/signOut",
      "/api/studyroom/v1/reservation/createQrSignCheckCode",
    ]);
    const cancelUrl = new URL(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).url);
    expect(Object.fromEntries(cancelUrl.searchParams)).toMatchObject({ reservationId: "18651", cancelType: "1" });
    const signoutUrl = new URL(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).url);
    expect(Object.fromEntries(signoutUrl.searchParams)).toMatchObject({ userId: "student-id", roomId: "23" });
  });

  it("uses the same room id and system mac for sign keys and sign submission", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(proxyResponse(200, JSON.stringify("short-lived-key")))
      .mockResolvedValueOnce(proxyResponse(200, JSON.stringify({ executionResult: true })));
    vi.stubGlobal("fetch", fetchMock);

    const key = await createOfficialQrSignCheckCode(env, "access-token", "2", "JWJA211231039");
    await submitOfficialSign(env, "access-token", "2", "JWJA211231039", key);

    const keyUrl = new URL(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).url);
    const signPayload = JSON.parse(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).body);
    expect(Object.fromEntries(keyUrl.searchParams)).toMatchObject({ roomId: "2", systemMac: "JWJA211231039" });
    expect(signPayload).toEqual({ systemMac: "JWJA211231039", roomId: "2", qrSignCheckCode: "short-lived-key" });
  });

  it("reports the campus VPN restriction without logging the upstream HTML", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(proxyResponse(200,
      "<!doctype html><html><title>网站维护</title><body>临时访问请登录校园VPN账号</body></html>",
      "text/html; charset=utf-8",
    )));

    await expect(refreshOfficialToken(env, "old-reflush-token")).rejects.toMatchObject({
      status: 502,
      code: "OFFICIAL_NETWORK_RESTRICTED",
    });

    expect(consoleError).toHaveBeenCalledOnce();
    const log = String(consoleError.mock.calls[0]?.[0]);
    expect(log).toContain('"htmlMarker":"network-restricted"');
    expect(log).not.toContain("校园VPN");
  });

  it("asks the user to rebind when the official refresh token has expired", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(proxyResponse(400, JSON.stringify({
      msg: "refreshToken已过期",
      code: 2008,
    }))));

    await expect(refreshOfficialToken(env, "expired-reflush-token")).rejects.toMatchObject({
      status: 401,
      code: "OFFICIAL_REAUTH_REQUIRED",
      message: "官方登录已失效，请重新绑定凭证",
    });
  });

  it("reports an unknown official error code without exposing the upstream message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(proxyResponse(400, JSON.stringify({
      msg: "upstream detail must stay private",
      code: 2999,
    }))));

    await expect(refreshOfficialToken(env, "reflush-token")).rejects.toMatchObject({
      status: 502,
      code: "OFFICIAL_REQUEST_FAILED",
      message: "官方接口请求失败 (400, 官方错误码: 2999)",
    });

    expect(String(consoleError.mock.calls[0]?.[0])).toBe(
      '{"level":"error","event":"official_request_failed","status":400,"officialCode":2999}',
    );
  });
});
