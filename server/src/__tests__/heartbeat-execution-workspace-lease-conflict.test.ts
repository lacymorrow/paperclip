import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { environmentService } from "../services/environments.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const execFileAsync = promisify(execFile);

/**
 * Heartbeat-level regression coverage for LAC-7736.
 *
 * The LAC-6296 exclusivity guard refuses a second run an active lease on a
 * single-branch worktree. Thrown from `acquireForRun`, that refusal landed in
 * the heartbeat setup catch, which recorded the run `failed`/`setup_failed` and
 * finalized the agent as `failed` with no `keepIdleOnFailure` - so the agent
 * went to `error` and stopped working on every other project because a
 * different agent held one worktree. Contention has to be a wait, not a crash.
 *
 * The orchestrator-level test in `execution-workspace-lease-exclusivity` proves
 * the error code. This one proves the behaviour the code is supposed to cause.
 */

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Lease conflict test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution workspace lease conflict tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function readGit(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function createGitRepoWithWorktree(branchName: string) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-lease-conflict-repo-"));
  await runGit(repoRoot, ["init", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "lease conflict\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  // Seed the base commit with plumbing rather than `git commit`. A developer
  // machine can configure a commit-author guard that fires even in a repo with
  // its own `core.hooksPath`, which rejects any fixture author; `commit-tree`
  // runs no hooks, so the fixture does not depend on host hook config.
  const treeSha = await readGit(repoRoot, ["write-tree"]);
  const commitSha = await readGit(repoRoot, ["commit-tree", treeSha, "-m", "initial"]);
  await runGit(repoRoot, ["update-ref", "refs/heads/main", commitSha]);

  const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", branchName);
  await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath]);
  return { repoRoot, worktreePath };
}

async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

/**
 * The deferral is scheduled after the run row flips to `failed`, so polling for
 * the retry (rather than reading once) is what makes this assertion about the
 * behaviour instead of about finalization ordering.
 */
async function waitForScheduledRetry(db: Db, retryOfRunId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let latest: typeof heartbeatRuns.$inferSelect | null = null;
  while (Date.now() < deadline) {
    latest = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "scheduled_retry"),
          eq(heartbeatRuns.retryOfRunId, retryOfRunId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest;
}

/**
 * Reads the agent until its status has been unchanged for `settleMs`, and
 * returns every distinct status it passed through. `finalizeAgentStatus` is the
 * last write of a run's finalization, so a single read taken when the run row
 * goes terminal observes the *pre*-finalization status and cannot tell an agent
 * left idle from one about to be errored.
 */
async function settleAgentStatus(
  db: Db,
  agentId: string,
  { settleMs = 1_500, timeoutMs = 15_000 }: { settleMs?: number; timeoutMs?: number } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const observed: string[] = [];
  let errorReason: string | null = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const row = await db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (row) {
      errorReason = row.errorReason;
      if (observed[observed.length - 1] !== row.status) {
        observed.push(row.status);
        stableSince = Date.now();
      }
    }
    if (Date.now() - stableSince >= settleMs) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { observed, status: observed[observed.length - 1] ?? null, errorReason };
}

async function waitForRunLeaseToRelease(db: Db, heartbeatRunId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let latest: { status: string; executionWorkspaceId: string | null } | null = null;
  while (Date.now() < deadline) {
    latest = await db
      .select({
        status: environmentLeases.status,
        executionWorkspaceId: environmentLeases.executionWorkspaceId,
      })
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, heartbeatRunId))
      .then((rows) => rows[0] ?? null);
    if (latest && latest.status !== "active") return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest;
}

async function waitForHeartbeatIdle(db: Db, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let idleSince: number | null = null;
  while (Date.now() < deadline) {
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 250) return;
    } else {
      idleSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function deleteHeartbeatRunsForCleanup(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

describeEmbeddedPostgres("heartbeat execution workspace lease conflict", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lease-conflict-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await waitForHeartbeatIdle(db);
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Lease conflict test run.",
      provider: "test",
      model: "test-model",
    }));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(issueRecoveryActions);
    await db.delete(environmentLeases);
    await deleteHeartbeatRunsForCleanup(db);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedContendedHeartbeatRun() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const holderAgentId = randomUUID();
    const contenderAgentId = randomUUID();
    const holderRunId = randomUUID();
    const contenderRunId = randomUUID();
    const contenderWakeupId = randomUUID();
    const holderIssueId = randomUUID();
    const contenderIssueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const branchName = `${issuePrefix}-1-shared-worktree`;
    const now = new Date();

    const { repoRoot, worktreePath } = await createGitRepoWithWorktree(branchName);
    tempRoots.push(repoRoot);

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Lease conflict",
      status: "active",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "HEAD",
          branchTemplate: "{{issue.identifier}}-shared-worktree",
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: repoRoot,
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    });
    // The holder is a *different* agent: that is the LAC-6296 shape, and it also
    // keeps `countRunningRunsForAgent` from making the contender read "running"
    // for the wrong reason when its status is finalized.
    await db.insert(agents).values([
      {
        id: holderAgentId,
        companyId,
        name: "HolderCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: contenderAgentId,
        companyId,
        name: "ContenderCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: branchName,
      status: "active",
      cwd: worktreePath,
      repoUrl: null,
      baseRef: "HEAD",
      branchName,
      providerType: "git_worktree",
      providerRef: worktreePath,
      lastUsedAt: now,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: holderAgentId,
      invocationSource: "manual",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: holderIssueId },
      responsibleUserId: "responsible-user",
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: contenderWakeupId,
      companyId,
      agentId: contenderAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: contenderIssueId },
      status: "queued",
      runId: contenderRunId,
      requestedAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: contenderRunId,
      companyId,
      agentId: contenderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: contenderWakeupId,
      contextSnapshot: {
        issueId: contenderIssueId,
        taskId: contenderIssueId,
        wakeReason: "issue_assigned",
      },
      responsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values([
      {
        id: holderIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Holder issue",
        status: "in_progress",
        workMode: "standard",
        priority: "high",
        assigneeAgentId: holderAgentId,
        executionRunId: holderRunId,
        executionAgentNameKey: "holdercoder",
        executionLockedAt: now,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: contenderIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Contender issue",
        status: "in_progress",
        workMode: "standard",
        priority: "high",
        assigneeAgentId: contenderAgentId,
        checkoutRunId: contenderRunId,
        executionRunId: contenderRunId,
        executionAgentNameKey: "contendercoder",
        executionLockedAt: now,
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        // Pinned at the same worktree the holder is in. Before LAC-6296 both
        // runs got a lease and edited one directory.
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const environmentsSvc = environmentService(db);
    const localEnvironment = await environmentsSvc.ensureLocalEnvironment(companyId);
    const holderLease = await environmentsSvc.acquireLease({
      companyId,
      environmentId: localEnvironment.id,
      executionWorkspaceId,
      issueId: holderIssueId,
      heartbeatRunId: holderRunId,
      leasePolicy: "ephemeral",
      provider: "local",
      metadata: { driver: "local", executionWorkspaceMode: "isolated_workspace" },
    });
    expect(holderLease.status).toBe("active");

    return {
      companyId,
      contenderAgentId,
      contenderIssueId,
      contenderRunId,
      environmentId: localEnvironment.id,
      executionWorkspaceId,
      holderLeaseId: holderLease.id,
      holderRunId,
      worktreePath,
    };
  }

  it("defers the run and keeps the agent idle when another run holds the worktree", async () => {
    const seeded = await seedContendedHeartbeatRun();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const finished = await waitForRunToFinish(heartbeat, seeded.contenderRunId);

    // The contention is recorded as itself, not as an opaque setup crash, so
    // recovery's continuation classifier can treat it as transient.
    expect(finished?.status).toBe("failed");
    expect(finished?.errorCode).toBe("execution_workspace_lease_conflict");
    expect(finished?.errorCode).not.toBe("setup_failed");
    expect(finished?.error).toContain(seeded.holderRunId);
    // Nothing was dispatched into the held worktree.
    expect(adapterExecute).not.toHaveBeenCalled();

    // Agent status is written last in the run's finalization, so sample the
    // whole settling window rather than reading once: a single early read saw
    // the pre-finalization `idle` and passed even with the fix removed.
    const contenderAgent = await settleAgentStatus(db, seeded.contenderAgentId);
    // The blast radius this gate exists to prevent: a worktree held by someone
    // else must not knock this agent out of every project.
    expect(contenderAgent.observed).not.toContain("error");
    expect(contenderAgent.status).toBe("idle");
    expect(contenderAgent.errorReason).toBeNull();

    // The work is deferred, not dropped.
    const scheduledRetry = await waitForScheduledRetry(db, seeded.contenderRunId);
    expect(scheduledRetry).not.toBeNull();
    expect(scheduledRetry?.scheduledRetryReason).toBe("execution_workspace_lease_conflict");
    expect(scheduledRetry?.scheduledRetryAttempt).toBe(1);
    expect(scheduledRetry?.scheduledRetryAt).toBeInstanceOf(Date);
    expect(scheduledRetry?.agentId).toBe(seeded.contenderAgentId);

    // The issue keeps a live execution path, so the stranded-issue sweep does
    // not also escalate it to `blocked` while the deferral is pending.
    const contenderIssue = await db
      .select({ status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, seeded.contenderIssueId))
      .then((rows) => rows[0] ?? null);
    expect(contenderIssue?.status).toBe("in_progress");
    expect(contenderIssue?.executionRunId).toBe(scheduledRetry?.id);

    // The holder kept its lease; the contender never got one.
    const leases = await db
      .select({
        id: environmentLeases.id,
        status: environmentLeases.status,
        heartbeatRunId: environmentLeases.heartbeatRunId,
      })
      .from(environmentLeases)
      .where(eq(environmentLeases.executionWorkspaceId, seeded.executionWorkspaceId));
    expect(leases).toEqual([
      expect.objectContaining({
        id: seeded.holderLeaseId,
        status: "active",
        heartbeatRunId: seeded.holderRunId,
      }),
    ]);
  }, 40_000);

  it("runs the deferred retry once the holder releases the worktree", async () => {
    const seeded = await seedContendedHeartbeatRun();
    const heartbeat = heartbeatService(db);
    const environmentsSvc = environmentService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToFinish(heartbeat, seeded.contenderRunId);

    const scheduledRetry = await waitForScheduledRetry(db, seeded.contenderRunId);
    expect(scheduledRetry).not.toBeNull();

    // The holder finishes and releases the worktree.
    await environmentsSvc.releaseLease(seeded.holderLeaseId);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, seeded.holderRunId));

    // Promote as of the retry's due time rather than sleeping through the backoff.
    const promoteAt = new Date((scheduledRetry!.scheduledRetryAt as Date).getTime() + 1_000);
    const promoted = await heartbeat.promoteDueScheduledRetries(promoteAt);
    expect(promoted.runIds).toContain(scheduledRetry!.id);

    await heartbeat.resumeQueuedRuns();
    const retried = await waitForRunToFinish(heartbeat, scheduledRetry!.id);

    expect(retried?.status).toBe("succeeded");
    expect(retried?.errorCode).toBeNull();
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    // The retry got the worktree the conflict denied it, and gave it back.
    const retryLease = await waitForRunLeaseToRelease(db, scheduledRetry!.id);
    expect(retryLease).not.toBeNull();
    expect(retryLease?.executionWorkspaceId).toBe(seeded.executionWorkspaceId);
    expect(retryLease?.status).toBe("released");
  }, 40_000);
});
