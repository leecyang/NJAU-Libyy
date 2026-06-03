export type ApiErrorBody = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const credentialErrorCodes = new Set([
  "OFFICIAL_REAUTH_REQUIRED",
  "CREDENTIAL_UNBOUND",
  "CREDENTIAL_NOT_ACTIVE",
  "OFFICIAL_CREDENTIAL_REQUIRED",
]);
const officialCredentialBadRequestCodes = new Set([
  "OFFICIAL_TOKEN_INVALID",
]);

let consecutiveOfficialCredential400 = 0;
let clearingCredential = false;

function isCredentialControlPath(path: string): boolean {
  return path.startsWith("/api/v1/credentials/") || path === "/api/v1/me";
}

function forceCredentialPage() {
  if (typeof window === "undefined" || window.location.pathname === "/credentials") return;
  window.history.replaceState(null, "", "/credentials");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function dispatchCredentialInvalidated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("credential-invalidated"));
  forceCredentialPage();
}

function redirectToCredentialPage(code: string, path: string) {
  if (!credentialErrorCodes.has(code) || isCredentialControlPath(path)) return;
  dispatchCredentialInvalidated();
}

async function clearCredentialSilently() {
  if (clearingCredential) return;
  clearingCredential = true;
  try {
    await fetch("/api/v1/credentials/clear", { method: "POST", credentials: "same-origin" }).catch(() => null);
  } finally {
    consecutiveOfficialCredential400 = 0;
    clearingCredential = false;
    dispatchCredentialInvalidated();
  }
}

function trackCredentialBadRequest(status: number, code: string, path: string) {
  const shouldCount = status === 400
    && officialCredentialBadRequestCodes.has(code)
    && !path.startsWith("/api/v1/credentials/");
  consecutiveOfficialCredential400 = shouldCount ? consecutiveOfficialCredential400 + 1 : 0;
  if (consecutiveOfficialCredential400 >= 3) void clearCredentialSilently();
}

function clearExpiredCredential(code: string, path: string) {
  if (isCredentialControlPath(path)) return;
  if (code === "OFFICIAL_REAUTH_REQUIRED" || code === "CREDENTIAL_NOT_ACTIVE") void clearCredentialSilently();
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type") && options.body) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: T } | ApiErrorBody | null;
  if (!response.ok || body?.ok === false) {
    const error = body && "error" in body ? body.error : { code: "REQUEST_FAILED", message: "请求失败" };
    trackCredentialBadRequest(response.status, error.code, path);
    clearExpiredCredential(error.code, path);
    redirectToCredentialPage(error.code, path);
    throw new ApiError(error.code, error.message, response.status);
  }
  consecutiveOfficialCredential400 = 0;
  return (body && "data" in body ? body.data : body) as T;
}
