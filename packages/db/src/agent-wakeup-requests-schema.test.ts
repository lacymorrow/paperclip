import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentWakeupRequests } from "./schema/agent_wakeup_requests.js";

describe("agent wakeup request schema", () => {
  it("atomically deduplicates review-path recovery fingerprints per company", () => {
    const index = getTableConfig(agentWakeupRequests).indexes.find(
      (candidate) => candidate.config.name === "agent_wakeup_requests_review_path_recovery_idempotency_uq",
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "company_id",
      "idempotency_key",
    ]);
    expect(index?.config.where).toBeDefined();
  });

  it("atomically deduplicates disposition-repair attempts per company", () => {
    const index = getTableConfig(agentWakeupRequests).indexes.find(
      (candidate) => candidate.config.name === "agent_wakeup_requests_disposition_repair_idempotency_uq",
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "company_id",
      "idempotency_key",
    ]);
    expect(index?.config.where).toBeDefined();
  });

  // The idempotency-key indexes above are all partial on a key prefix, so a
  // lookup by any other prefix had no index and read the whole table. Keep one
  // unconditional index on the pair so no future key shape loses coverage.
  it("indexes every idempotency key, not only the prefixes with a partial index", () => {
    const indexes = getTableConfig(agentWakeupRequests).indexes.filter(
      (candidate) =>
        candidate.config.where === undefined &&
        candidate.config.columns.map((column) => (column as { name: string }).name).join(",") ===
          "company_id,idempotency_key",
    );

    expect(indexes.map((index) => index.config.name)).toEqual([
      "agent_wakeup_requests_company_idempotency_key_idx",
    ]);
    expect(indexes[0]?.config.concurrently).toBe(true);
  });
});
