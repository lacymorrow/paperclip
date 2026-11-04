import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./recovery/pause-hold-guard.js";

/**
 * Status an issue moves to once every blocker it waits on is resolved. The
 * issue keeps its assignee, so `todo` is the assigned-and-ready state the
 * dispatcher already understands.
 */
export const DEPENDENCY_READY_UNBLOCK_STATUS = "todo" as const;

export const DEPENDENCY_READY_UNBLOCK_ACTIVITY_ACTION = "issue.dependency_ready_unblocked";

/** Recovery action statuses that mean someone else still owns the park. */
const OWNED_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const;

/** Interaction continuation policies whose pending answer owns the next wake. */
const WAKE_CONTINUATION_POLICIES = ["wake_assignee", "wake_assignee_on_accept"] as const;

export type DependencyReadyUnblockActorType = "agent" | "plugin" | "system" | "user";

export type DependencyReadyUnblockSkipReason =
  | "issue_missing"
  | "not_blocked"
  | "unblock_descriptor"
  | "recovery_action"
  | "pending_interaction"
  | "pause_hold"
  | "no_assignee"
  | "update_rejected"
  | "error";

export type DependencyReadyUnblockResult =
  | { unblocked: true; previousStatus: string; identifier: string | null }
  | { unblocked: false; reason: DependencyReadyUnblockSkipReason };

export type DependencyReadyUnblockInput = {
  companyId: string;
  issueId: string;
  /** The blocker set that made the issue ready, used for the audit trail. */
  blockerIssueIds: string[];
  /** Emit path that observed the readiness, e.g. `issue.blockers_resolved`. */
  source: string;
  runId?: string | null;
  /** Assignee the wake is addressed to, recorded on the activity row. */
  agentId?: string | null;
  actorType?: DependencyReadyUnblockActorType;
  actorId?: string | null;
};

type UnblockDeps = {
  issuesSvc?: ReturnType<typeof issueService>;
  treeControlSvc?: ReturnType<typeof issueTreeControlService>;
};

function formatBlockerLinks(rows: Array<{ identifier: string | null }>) {
  const identifiers = [
    ...new Set(rows.map((row) => row.identifier).filter((id): id is string => Boolean(id))),
  ];
  if (identifiers.length === 0) return "every task it was waiting on";
  return identifiers
    .slice(0, 5)
    .map((identifier) => {
      const prefix = identifier.split("-")[0] || "PAP";
      return `[${identifier}](/${prefix}/issues/${identifier})`;
    })
    .join(", ");
}

/**
 * Move a dependency-ready `blocked` issue back to `todo`.
 *
 * Emitting `issue_blockers_resolved` is not enough on its own. The wake asks the
 * assignee to move the issue, and when the agent does not, the issue keeps the
 * one status every sweep, standup check and agent reads as "not my turn", so it
 * parks forever even though the platform's own blocker diagnostics report it as
 * `done_but_blocking`. Writing the transition here makes readiness the thing
 * that moves the issue, and the wake only the notification.
 *
 * The guards are the ones the dependency backstop already applies: an issue
 * whose park belongs to a recovery action, an unblock descriptor, a pending
 * confirmation, or a pause hold is left alone for that owner.
 */
export async function unblockDependencyReadyIssue(
  db: Db,
  input: DependencyReadyUnblockInput,
  deps: UnblockDeps = {},
): Promise<DependencyReadyUnblockResult> {
  // Never throws. Callers emit the wake right after this returns, and the wake
  // is the notification the assignee depends on; a failed status write must
  // not swallow it. A failure here reads as "not unblocked" and the dependency
  // backstop retries the transition on its next sweep.
  try {
    return await unblockDependencyReadyIssueUnsafe(db, input, deps);
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId, source: input.source },
      "dependency-ready unblock failed; leaving issue blocked for the backstop",
    );
    return { unblocked: false, reason: "error" };
  }
}

async function unblockDependencyReadyIssueUnsafe(
  db: Db,
  input: DependencyReadyUnblockInput,
  deps: UnblockDeps,
): Promise<DependencyReadyUnblockResult> {
  const issuesSvc = deps.issuesSvc ?? issueService(db);

  const issue = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      unblockDescriptor: issues.unblockDescriptor,
    })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue) return { unblocked: false, reason: "issue_missing" };
  if (issue.status !== "blocked") return { unblocked: false, reason: "not_blocked" };
  // `todo` means "assigned and ready". Without an assignee nobody is told and
  // nobody owns it, so the issue would leave the one status that still
  // surfaces it as parked.
  if (!issue.assigneeAgentId && !issue.assigneeUserId) {
    return { unblocked: false, reason: "no_assignee" };
  }
  // An unblock descriptor names the owner who has to act. Clearing the status
  // would take the issue off that owner's queue without the action happening.
  if (issue.unblockDescriptor) return { unblocked: false, reason: "unblock_descriptor" };

  const ownedRecoveryAction = await db
    .select({ id: issueRecoveryActions.id })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, input.companyId),
        eq(issueRecoveryActions.sourceIssueId, input.issueId),
        or(
          inArray(issueRecoveryActions.status, [...OWNED_RECOVERY_ACTION_STATUSES]),
          // A resolved action can still hold execution: replay stays blocked
          // until its evidence clears, and the wake path defers behind it. Moving
          // the issue to `todo` underneath that hold would hide the park from
          // the backstop that resumes it once the hold lifts.
          sql`${issueRecoveryActions.evidence} -> 'automaticRecovery' ->> 'replay' = 'blocked'`,
        ),
      ),
    )
    .limit(1)
    .then((rows) => Boolean(rows[0]));
  if (ownedRecoveryAction) return { unblocked: false, reason: "recovery_action" };

  const pendingInteraction = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
        inArray(issueThreadInteractions.continuationPolicy, [...WAKE_CONTINUATION_POLICIES]),
      ),
    )
    .limit(1)
    .then((rows) => Boolean(rows[0]));
  if (pendingInteraction) return { unblocked: false, reason: "pending_interaction" };

  if (
    await isAutomaticRecoverySuppressedByPauseHold(
      db,
      input.companyId,
      input.issueId,
      deps.treeControlSvc,
    )
  ) {
    return { unblocked: false, reason: "pause_hold" };
  }

  const updated = await issuesSvc.update(input.issueId, {
    status: DEPENDENCY_READY_UNBLOCK_STATUS,
    companyGuard: input.companyId,
  });
  if (!updated) return { unblocked: false, reason: "update_rejected" };

  // The status write above is the transition. Comment and activity are audit
  // trail; losing them must not report the transition as failed.
  try {
    await writeUnblockAudit(db, input, issue, issuesSvc);
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId },
      "dependency-ready unblock audit write failed after the status moved",
    );
  }

  return { unblocked: true, previousStatus: issue.status, identifier: issue.identifier };
}

async function writeUnblockAudit(
  db: Db,
  input: DependencyReadyUnblockInput,
  issue: { identifier: string | null; status: string },
  issuesSvc: ReturnType<typeof issueService>,
) {
  const blockerRows =
    input.blockerIssueIds.length > 0
      ? await db
          .select({ identifier: issues.identifier })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              inArray(issues.id, input.blockerIssueIds),
              isNotNull(issues.identifier),
            ),
          )
      : [];

  await issuesSvc.addComment(
    input.issueId,
    `${formatBlockerLinks(blockerRows)} finished, so this task is no longer blocked. ` +
      `Paperclip moved it to \`${DEPENDENCY_READY_UNBLOCK_STATUS}\` and told its assignee to pick it up.`,
    {},
    { authorType: "system" },
  );

  await logActivity(db, {
    companyId: input.companyId,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? "dependency_ready_unblock",
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    action: DEPENDENCY_READY_UNBLOCK_ACTIVITY_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    details: {
      identifier: issue.identifier,
      status: DEPENDENCY_READY_UNBLOCK_STATUS,
      previousStatus: issue.status,
      source: input.source,
      blockerIssueIds: input.blockerIssueIds,
    },
  });
}
