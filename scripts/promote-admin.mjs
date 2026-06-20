#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

function usage() {
  console.error("Usage: node scripts/promote-admin.mjs [--email user@example.com] [--db /path/to/njau-libyy.sqlite]");
}

function parseArgs(argv) {
  const args = { email: process.env.ADMIN_EMAIL ?? "", db: process.env.SQLITE_PATH ?? "/data/njau-libyy.sqlite" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--email" || value === "-e") {
      args.email = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value.startsWith("--email=")) {
      args.email = value.slice("--email=".length);
      continue;
    }
    if (value === "--db") {
      args.db = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value.startsWith("--db=")) {
      args.db = value.slice("--db=".length);
      continue;
    }
    usage();
    process.exit(2);
  }
  args.email = args.email.trim().toLowerCase();
  return args;
}

const { email, db } = parseArgs(process.argv.slice(2));

if (!db) {
  usage();
  process.exit(2);
}

if (!fs.existsSync(db)) {
  console.error(`[admin] SQLite database not found: ${db}`);
  process.exit(1);
}

const database = new Database(db);
database.pragma("foreign_keys = ON");

try {
  const user = email
    ? database.prepare("SELECT id, email, role, status FROM users WHERE lower(email) = lower(?)").get(email)
    : (() => {
        const activeUsers = database.prepare(
          "SELECT id, email, role, status FROM users WHERE status = 'ACTIVE' ORDER BY created_at ASC",
        ).all();
        if (activeUsers.length !== 1) {
          console.error(`[admin] Refusing to guess user: found ${activeUsers.length} active users.`);
          console.error("[admin] Re-run with --email user@example.com.");
          for (const candidate of activeUsers.slice(0, 20)) {
            console.error(`[admin] candidate: ${candidate.email} (${candidate.role}, ${candidate.status})`);
          }
          process.exit(1);
        }
        return activeUsers[0];
      })();

  if (!user) {
    console.error(`[admin] User not found: ${email}`);
    process.exit(1);
  }

  if (user.status !== "ACTIVE") {
    console.error(`[admin] User is not ACTIVE: ${user.email} (${user.status})`);
    process.exit(1);
  }

  const now = Date.now();
  const promote = database.transaction(() => {
    const result = database.prepare("UPDATE users SET role = 'ADMIN', updated_at = ? WHERE id = ? AND role <> 'ADMIN'")
      .run(now, user.id);
    if (result.changes) {
      database.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, actor_type, action, target_type, target_id, result, metadata_redacted_json, created_at)
         VALUES (?, ?, 'SYSTEM', 'ADMIN_USER_PROMOTED', 'USER', ?, 'SUCCESS', ?, ?)`,
      ).run(
        randomUUID(),
        user.id,
        user.id,
        JSON.stringify({ email: user.email, previousRole: user.role, source: path.basename(process.argv[1]) }),
        now,
      );
    }
    return result.changes;
  });

  const changes = promote();
  const updated = database.prepare("SELECT email, role FROM users WHERE id = ?").get(user.id);
  console.log(`[admin] ${changes ? "Promoted" : "Already admin"}: ${updated.email} (${updated.role})`);
} finally {
  database.close();
}
