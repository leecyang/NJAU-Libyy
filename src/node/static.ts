import fs from "node:fs/promises";
import path from "node:path";

const types: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function safePath(root: string, requestPath: string): string {
  const decoded = decodeURIComponent(requestPath.split("?")[0] ?? "/");
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const absolute = path.join(root, normalized === "/" ? "index.html" : normalized);
  if (!absolute.startsWith(root)) return path.join(root, "index.html");
  return absolute;
}

export async function serveStatic(root: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  let filename = safePath(root, url.pathname);
  try {
    const stat = await fs.stat(filename);
    if (stat.isDirectory()) filename = path.join(filename, "index.html");
  } catch {
    filename = path.join(root, "index.html");
  }
  try {
    const bytes = await fs.readFile(filename);
    return new Response(bytes, {
      headers: {
        "content-type": types[path.extname(filename)] ?? "application/octet-stream",
        "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Frontend build not found", { status: 503 });
  }
}

