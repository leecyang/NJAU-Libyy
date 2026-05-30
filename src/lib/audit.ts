export async function audit(
  db: D1Database,
  entry: {
    actorUserId?: string;
    actorType: "USER" | "ADMIN" | "SYSTEM";
    action: string;
    targetType: string;
    targetId?: string;
    result: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_logs
      (id, actor_user_id, actor_type, action, target_type, target_id, result, metadata_redacted_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    entry.actorUserId ?? null,
    entry.actorType,
    entry.action,
    entry.targetType,
    entry.targetId ?? null,
    entry.result,
    JSON.stringify(entry.metadata ?? {}),
    Date.now(),
  ).run();
}

