import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("agent_wakeup_requests idempotency key index migration", () => {
  it("applies the full chain and serves a lookup by any key prefix", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("lac8707-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'agent_wakeup_requests'`;
    expect(idx.map((row) => row.indexname as string)).toContain(
      "agent_wakeup_requests_company_idempotency_key_idx",
    );

    // Unconditional, so it covers prefixes no partial index names.
    const definition = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'agent_wakeup_requests_company_idempotency_key_idx'`;
    expect(definition[0]?.indexdef as string).not.toContain("WHERE");

    // The dependency-wake coverage read. Its keys carry no prefix that any
    // partial index matches, so before this index the only plan was a full
    // table scan.
    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      "EXPLAIN SELECT id, status, idempotency_key, requested_at FROM agent_wakeup_requests " +
        "WHERE company_id = '00000000-0000-0000-0000-000000000001' " +
        "AND idempotency_key IN ('issue_blockers_resolved_ready:a:b', 'issue_blockers_resolved_ready:a:c')",
    );
    expect(plan.map((row) => Object.values(row)[0]).join("\n")).toContain(
      "agent_wakeup_requests_company_idempotency_key_idx",
    );

    // Re-running the migration against an already migrated database is a no-op.
    const migrationSql = await readFile(
      fileURLToPath(new URL("./migrations/0492_wake_idempotency_key_index.sql", import.meta.url)),
      "utf8",
    );
    for (const statement of migrationSql
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)) {
      await sql.unsafe(statement);
    }

    const after = await sql`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE indexname = 'agent_wakeup_requests_company_idempotency_key_idx'`;
    expect(after[0]?.n).toBe(1);
  }, 240_000);
});
