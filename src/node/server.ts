import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fail } from "../lib/http";
import { runScheduler } from "../lib/scheduler";
import { routeApi } from "../router";
import { registerOfficialGatewayHandlers } from "../api/app";
import { registerTeamScoresGatewayHandler } from "../api/team-scores";
import { loadNodeEnv, nodePort } from "./env";
import { applyMigrations } from "./migrations";
import { openSqliteDatabase } from "./sqlite";
import { serveStatic } from "./static";
import { CasLoginManager } from "./cas-login";
import { NodeOfficialAccessGateway } from "./official-access-gateway";

const root = process.cwd();
const databasePath = process.env.SQLITE_PATH ?? "/data/njau-libyy.sqlite";
const staticRoot = process.env.WEB_DIST_DIR ?? path.join(root, "apps/web/dist");
const migrationsDir = process.env.MIGRATIONS_DIR ?? path.join(root, "migrations");

const db = openSqliteDatabase(databasePath);
applyMigrations(db, migrationsDir);
const env = loadNodeEnv(db);
const officialGateway = new NodeOfficialAccessGateway(env);
env.OFFICIAL_GATEWAY = officialGateway;
registerOfficialGatewayHandlers(env);
registerTeamScoresGatewayHandler(env);
await officialGateway.initialize();
const casLoginManager = new CasLoginManager(env);
env.CAS_AUTOMATION = casLoginManager;
await casLoginManager.initialize();

let schedulerRunning = false;

async function runSchedulerOnce(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    await runScheduler(env);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "scheduler_failed", message: error instanceof Error ? error.message : "unknown" }));
  } finally {
    schedulerRunning = false;
  }
}

function requestUrl(request: http.IncomingMessage): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto ?? "http";
  const host = request.headers.host ?? `localhost:${nodePort()}`;
  return `${proto}://${host}${request.url ?? "/"}`;
}

function nodeRequestToFetch(request: http.IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(requestUrl(request), {
    method,
    headers,
    body: hasBody ? Readable.toWeb(request) as ReadableStream : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit & { duplex?: "half" });
}

async function writeResponse(response: Response, reply: http.ServerResponse): Promise<void> {
  reply.statusCode = response.status;
  response.headers.forEach((value, name) => reply.setHeader(name, value));
  const body = Buffer.from(await response.arrayBuffer());
  reply.end(body);
}

const server = http.createServer((request, reply) => {
  void (async () => {
    try {
      const fetchRequest = nodeRequestToFetch(request);
      const url = new URL(fetchRequest.url);
      const response = url.pathname.startsWith("/api/")
        ? await routeApi(env, fetchRequest)
        : await serveStatic(staticRoot, fetchRequest);
      await writeResponse(response, reply);
    } catch (error) {
      await writeResponse(fail(error, { method: request.method, url: request.url }), reply);
    }
  })();
});

const port = nodePort();
server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", event: "server_started", port, staticRoot, databasePath }));
});

setInterval(() => void runSchedulerOnce(), 60_000).unref();
void runSchedulerOnce();
