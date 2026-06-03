import fs from "node:fs";
import path from "node:path";
import type { SqliteD1Database } from "./sqlite";

export function applyMigrations(db: SqliteD1Database, migrationsDir: string): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(
    db.raw.prepare("SELECT name FROM _migrations").all().map((row) => String((row as { name: string }).name)),
  );
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const migrate = db.raw.transaction((name: string, sql: string) => {
    db.raw.exec(sql);
    db.raw.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
  });

  for (const name of files) {
    if (applied.has(name)) continue;
    migrate(name, fs.readFileSync(path.join(migrationsDir, name), "utf8"));
    console.log(JSON.stringify({ level: "info", event: "migration_applied", name }));
  }
}

