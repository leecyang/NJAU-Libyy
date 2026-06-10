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

export type GatewayJob<T = unknown> = {
  jobId: string;
  kind: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  result: T | null;
  error: { code: string; message: string | null } | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
};

const credentialErrorCodes = new Set([
  "OFFICIAL_REAUTH_REQUIRED",
  "CREDENTIAL_UNBOUND",
  "CREDENTIAL_NOT_ACTIVE",
  "CREDENTIAL_RECOVERY_IN_PROGRESS",
  "OFFICIAL_CREDENTIAL_REQUIRED",
]);

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
    redirectToCredentialPage(error.code, path);
    throw new ApiError(error.code, error.message, response.status);
  }
  return (body && "data" in body ? body.data : body) as T;
}

export async function waitForGatewayJob<T>(initial: GatewayJob<T>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let job = initial;
  while (job.status === "QUEUED" || job.status === "RUNNING") {
    if (Date.now() >= deadline) throw new ApiError("GATEWAY_JOB_TIMEOUT", "官方访问任务仍在处理中，请稍后查看", 408);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
    job = await api<GatewayJob<T>>(`/api/v1/official-jobs/${encodeURIComponent(job.jobId)}`);
  }
  if (job.status !== "SUCCEEDED") {
    const code = job.error?.code ?? "GATEWAY_JOB_FAILED";
    redirectToCredentialPage(code, `/api/v1/official-jobs/${encodeURIComponent(job.jobId)}`);
    throw new ApiError(code, job.error?.message ?? "官方访问任务执行失败", 502);
  }
  return job.result as T;
}
