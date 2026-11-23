-- Dependency-wake coverage reads look up agent_wakeup_requests by
-- (company_id, idempotency_key). Every existing index on that pair is partial on a
-- key prefix, so a key outside those prefixes had no index and Postgres scanned the
-- whole table: 136,358 rows removed by filter per worker, 489 ms, 32 scans a minute
-- measured on zero 2026-11-23. CONCURRENTLY so the build does not block wake writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_company_idempotency_key_idx" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key");
