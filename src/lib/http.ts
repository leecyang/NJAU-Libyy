const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function ok(data: unknown = {}): Response {
  return json({ ok: true, data });
}

export function fail(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }

  console.error(JSON.stringify({ level: "error", event: "unhandled_error", message: "Internal error" }));
  return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } }, 500);
}

export async function readJsonBody<T>(request: Request, maxBytes = 32_768): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "请求内容过大");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "请求内容过大");
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求格式错误");
  }
}

export function requireString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new HttpError(400, "INVALID_FIELD", `${field} 格式错误`);
  }
  return value.trim();
}

export async function readBoundedJson(response: Response, maxBytes = 262_144): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new Error("Official response is too large");
  }

  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Official response is too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

