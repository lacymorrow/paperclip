import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, issues } from "@paperclipai/db";
import {
  blockedInboxGraphIssueColumns,
  blockedInboxGraphIssuesQuery,
} from "../services/issues.js";

// The blocker graph covers every non-done issue in the company, so this read is the one that has to
// stay narrow. postgres-js connects lazily and `toSQL()` never issues a query, so no server is
// needed to read the projection back out of the statement.
const db = createDb("postgres://paperclip:paperclip@127.0.0.1:1/unused");
const companyId = "00000000-0000-0000-0000-000000000001";

// Every field the consumers of `graphIssues` read: the `issues:` payload handed to the liveness
// classifier, the recovery-origin filter, `issueRef`, and the review-wait closure.
const consumerFields = [
  "assigneeAgentId",
  "assigneeUserId",
  "companyId",
  "conversationAgentId",
  "conversationState",
  "conversationUserId",
  "createdByAgentId",
  "createdByUserId",
  "executionPolicy",
  "executionState",
  "goalId",
  "id",
  "identifier",
  "monitorAttemptCount",
  "monitorNextCheckAt",
  "originId",
  "originKind",
  "parentId",
  "priority",
  "projectId",
  "status",
  "title",
  "updatedAt",
];

function selectedColumnNames(): string[] {
  const { sql } = blockedInboxGraphIssuesQuery(db, companyId).toSQL();
  const list = sql.slice("select ".length, sql.indexOf(" from "));
  return [...list.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
}

describe("blocked-inbox blocker graph issue read", () => {
  it("selects every column its consumers read", () => {
    expect(Object.keys(blockedInboxGraphIssueColumns).sort()).toEqual([...consumerFields].sort());
  });

  it("does not carry the issue description, which no consumer reads", () => {
    const selected = selectedColumnNames();
    expect(selected).not.toContain("description");
    expect(selected).toContain("id");
    expect(selected).toContain("status");
  });

  it("stays a projection rather than growing back into a whole-row read", () => {
    const selected = selectedColumnNames();
    const tableColumns = Object.keys(getTableColumns(issues));
    expect(tableColumns.length).toBeGreaterThan(consumerFields.length);
    expect(selected).toHaveLength(consumerFields.length);
    expect(selected.length).toBeLessThan(tableColumns.length);
  });
});
