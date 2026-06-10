import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../apps/web/src/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web api client", () => {
  it("unwraps successful API responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { ready: true } }), {
      headers: { "content-type": "application/json" },
    })));

    await expect(api<{ ready: boolean }>("/api/v1/health")).resolves.toEqual({ ready: true });
    expect(fetch).toHaveBeenCalledWith("/api/v1/health", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("throws API errors with code and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "AUTH_REQUIRED", message: "请先登录" },
    }), { status: 401 })));

    await expect(api("/api/v1/me")).rejects.toMatchObject(new ApiError("AUTH_REQUIRED", "请先登录", 401));
  });

  it("never clears server credentials after repeated official token errors", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "OFFICIAL_TOKEN_INVALID", message: "凭证格式错误，请重新复制" },
      }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/api/v1/rooms")).rejects.toMatchObject(new ApiError("OFFICIAL_TOKEN_INVALID", "凭证格式错误，请重新复制", 400));
    await expect(api("/api/v1/rooms")).rejects.toMatchObject(new ApiError("OFFICIAL_TOKEN_INVALID", "凭证格式错误，请重新复制", 400));
    await expect(api("/api/v1/rooms")).rejects.toMatchObject(new ApiError("OFFICIAL_TOKEN_INVALID", "凭证格式错误，请重新复制", 400));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("credentials/clear"))).toBe(false);
  });
});
