import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];

// A git worktree is one directory checked out on one branch. Every issue bound
// to it shares that single branch slot, so a binding to a worktree is a lease on
// a branch. A shared repository root (`project_primary`) is the opposite case:
// many issues are meant to work in it, and its branch keeps moving, so none of
// the re-examination below applies to it.
export const BRANCH_PINNED_WORKSPACE_STRATEGY = "git_worktree";

export type ClearedWorkspaceBinding = {
  issueId: string;
  identifier: string | null;
  executionWorkspaceId: string;
};

export type WorkspaceBindingActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
};

// The issue and every issue below it, by `parent_id`. Sharing one worktree
// inside a single subtree is designed behaviour: a subtask is work on its
// parent's branch. Sharing it across subtrees is not.
function issueSubtreeIds(companyId: string, rootIssueId: string) {
  return sql`(
    WITH RECURSIVE issue_subtree(id) AS (
      SELECT root.id
      FROM ${issues} root
      WHERE root.company_id = ${companyId}
        AND root.id = ${rootIssueId}
      UNION ALL
      SELECT child.id
      FROM ${issues} child
      JOIN issue_subtree parent ON child.parent_id = parent.id
      WHERE child.company_id = ${companyId}
    )
    SELECT id FROM issue_subtree
  )`;
}

// Drop the execution workspace pointer on the named issues and send them back to
// their own workspace. The write touches those two columns only: it preserves
// status, it requests no wake, and the next run on the issue builds the workspace
// it should have had. A terminal issue is never touched, because a finished issue
// needs no workspace and its recorded binding is history.
async function clearBindings(
  db: Db,
  input: {
    companyId: string;
    workspaceIds: string[];
    keepSubtreeOfIssueId: string | null;
    keepIssueIds: string[];
    actor: WorkspaceBindingActor;
    reason: string;
    sourceIssueId: string | null;
  },
): Promise<ClearedWorkspaceBinding[]> {
  if (input.workspaceIds.length === 0) return [];
  const tenantConditions = [
    eq(issues.companyId, input.companyId),
    inArray(issues.executionWorkspaceId, input.workspaceIds),
    notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
    ...(input.keepIssueIds.length > 0 ? [notInArray(issues.id, input.keepIssueIds)] : []),
    ...(input.keepSubtreeOfIssueId
      ? [sql<boolean>`${issues.id} NOT IN ${issueSubtreeIds(input.companyId, input.keepSubtreeOfIssueId)}`]
      : []),
  ];
  const tenants = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      executionWorkspaceId: issues.executionWorkspaceId,
    })
    .from(issues)
    .where(and(...tenantConditions));
  if (tenants.length === 0) return [];
  // Re-assert the tenant predicates on the write, so a status change that landed
  // between the read and the write cannot clear a workspace the issue just earned.
  await db
    .update(issues)
    .set({ executionWorkspaceId: null, executionWorkspacePreference: "isolated_workspace" })
    .where(and(
      inArray(issues.id, tenants.map((tenant) => tenant.id)),
      ...tenantConditions,
    ));
  const cleared = tenants.map((tenant) => ({
    issueId: tenant.id,
    identifier: tenant.identifier,
    executionWorkspaceId: tenant.executionWorkspaceId as string,
  }));
  for (const binding of cleared) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? null,
      action: "execution_workspace.stale_binding_cleared",
      entityType: "issue",
      entityId: binding.issueId,
      issueId: binding.issueId,
      details: {
        identifier: binding.identifier,
        executionWorkspaceId: binding.executionWorkspaceId,
        sourceIssueId: input.sourceIssueId,
        reason: input.reason,
      },
    });
  }
  return cleared;
}

// Re-examine every lease on a worktree whose source issue just finished.
//
// A binding made while the source issue was live is legal when it is made and
// defective the moment the source issue closes: the branch stops moving, nothing
// re-reads the binding, and no event fires. The co-tenant then drifts from the
// base branch at one release per merge until it opens a pull request that
// proposes undoing all of it. Clear those leases at the close that froze the
// branch. The source issue's own subtree keeps sharing, and so does the source
// issue itself, which is the one issue the runtime can reopen the workspace for.
export async function clearStaleWorkspaceBindingsForTerminalIssue(
  db: Db,
  input: {
    companyId: string;
    sourceIssueId: string;
    actor: WorkspaceBindingActor;
  },
): Promise<ClearedWorkspaceBinding[]> {
  const workspaces = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(and(
      eq(executionWorkspaces.companyId, input.companyId),
      eq(executionWorkspaces.sourceIssueId, input.sourceIssueId),
      eq(executionWorkspaces.strategyType, BRANCH_PINNED_WORKSPACE_STRATEGY),
    ));
  return await clearBindings(db, {
    companyId: input.companyId,
    workspaceIds: workspaces.map((workspace) => workspace.id),
    keepSubtreeOfIssueId: input.sourceIssueId,
    keepIssueIds: [],
    actor: input.actor,
    reason: "source_issue_terminal",
    sourceIssueId: input.sourceIssueId,
  });
}

// Re-examine every lease on a workspace that just left the active state.
//
// An archive deletes the worktree directory. A bound issue whose preference is
// `reuse_existing` then asks the runtime to restore a directory that is gone:
// the restore cannot validate, so the issue parks under a recovery action
// instead of working, and no close-time or create-time check reaches it. The
// workspace's own source issue keeps its binding, because the runtime reopens an
// archived workspace for its source issue and for no one else.
export async function clearWorkspaceBindingsForClosedWorkspace(
  db: Db,
  input: {
    companyId: string;
    workspaceId: string;
    sourceIssueId: string | null;
    actor: WorkspaceBindingActor;
    reason: string;
  },
): Promise<ClearedWorkspaceBinding[]> {
  return await clearBindings(db, {
    companyId: input.companyId,
    workspaceIds: [input.workspaceId],
    keepSubtreeOfIssueId: null,
    keepIssueIds: input.sourceIssueId ? [input.sourceIssueId] : [],
    actor: input.actor,
    reason: input.reason,
    sourceIssueId: input.sourceIssueId,
  });
}

// Whether a new issue may adopt an existing workspace it did not ask for by
// name, inherited from its parent or from another issue.
//
// Two workspaces must not be inherited. One that has left the active state has
// no directory to share, and only its own source issue can reopen it. One
// pinned to a single branch whose source issue has finished is a frozen branch,
// and adopting it hands the new issue a lease that is already stale. An issue
// inside the finished issue's own subtree still inherits: that is the same
// designed sharing a live parent gets, and the subtree is the unit that was
// delivered on the branch.
export async function executionWorkspaceIsInheritable(
  db: Db,
  input: {
    companyId: string;
    workspace: { status: string; strategyType: string; sourceIssueId: string | null };
    parentIssueId: string | null;
  },
): Promise<boolean> {
  const { workspace } = input;
  // `archived` and `cleanup_failed` are the two closed states. `idle` and
  // `in_review` are live states that still own their directory, so they stay
  // inheritable.
  if (workspace.status === "archived" || workspace.status === "cleanup_failed") return false;
  if (workspace.strategyType !== BRANCH_PINNED_WORKSPACE_STRATEGY) return true;
  if (!workspace.sourceIssueId) return true;
  const sourceIssue = await db
    .select({ status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, workspace.sourceIssueId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!sourceIssue || !TERMINAL_ISSUE_STATUSES.includes(sourceIssue.status)) return true;
  if (!input.parentIssueId) return false;
  const inheritedInsideSubtree = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.parentIssueId),
      sql<boolean>`${issues.id} IN ${issueSubtreeIds(input.companyId, workspace.sourceIssueId)}`,
    ))
    .then((rows) => rows[0] ?? null);
  return inheritedInsideSubtree !== null;
}
