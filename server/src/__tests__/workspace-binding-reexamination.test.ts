import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import { clearWorkspaceBindingsForClosedWorkspace } from "../services/execution-workspace-bindings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// A worktree workspace is one directory pinned to one branch. An issue bound to
// a worktree whose source issue has finished holds a lease on a branch that
// stopped moving, so these tests cover the two moments that lease has to be
// re-examined: the close that freezes the branch, and the create that would
// adopt an already-frozen branch.
describeEmbeddedPostgres("execution workspace binding re-examination", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-binding-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function readIssue(id: string) {
    return await db
      .select({
        status: issues.status,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0]!);
  }

  async function seedWorkspace(options: {
    strategyType?: string;
    sourceStatus?: string;
    workspaceStatus?: string;
    attachSourceIssue?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Worktree project",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: options.strategyType ?? "git_worktree",
      name: "Source worktree",
      status: options.workspaceStatus ?? "active",
      providerType: "git_worktree",
      cwd: `/tmp/paperclip-binding-${executionWorkspaceId}`,
      branchName: "source-branch",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      title: "Source issue",
      status: options.sourceStatus ?? "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    if (options.attachSourceIssue !== false) {
      await db
        .update(executionWorkspaces)
        .set({ sourceIssueId })
        .where(eq(executionWorkspaces.id, executionWorkspaceId));
    }
    return { companyId, projectId, executionWorkspaceId, sourceIssueId };
  }

  async function bindTenant(input: {
    companyId: string;
    projectId: string;
    executionWorkspaceId: string;
    parentId?: string | null;
    status?: string;
    title: string;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      parentId: input.parentId ?? null,
      title: input.title,
      status: input.status ?? "in_progress",
      priority: "medium",
      executionWorkspaceId: input.executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    return id;
  }

  it("clears an unrelated co-tenant binding when the source issue closes and keeps the subtree bound", async () => {
    const seed = await seedWorkspace();
    const child = await bindTenant({ ...seed, parentId: seed.sourceIssueId, status: "todo", title: "Descendant subtask" });
    const grandchild = await bindTenant({ ...seed, parentId: child, status: "todo", title: "Descendant of descendant" });
    const unrelated = await bindTenant({ ...seed, title: "Unrelated co-tenant" });
    const unrelatedDone = await bindTenant({ ...seed, status: "done", title: "Unrelated finished co-tenant" });

    await svc.update(seed.sourceIssueId, { status: "done" });

    // Designed sharing: the subtree keeps the checkout it was created against.
    expect(await readIssue(child)).toMatchObject({
      status: "todo",
      executionWorkspaceId: seed.executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    expect(await readIssue(grandchild)).toMatchObject({
      executionWorkspaceId: seed.executionWorkspaceId,
    });
    // The source issue keeps its own binding: it is the one issue the runtime
    // can reopen the archived workspace for.
    expect(await readIssue(seed.sourceIssueId)).toMatchObject({
      executionWorkspaceId: seed.executionWorkspaceId,
    });
    // The defect: an unrelated tenant now holds a lease on a frozen branch.
    expect(await readIssue(unrelated)).toMatchObject({
      status: "in_progress",
      executionWorkspaceId: null,
      executionWorkspacePreference: "isolated_workspace",
    });
    // A finished tenant needs no workspace, so leave its history alone.
    expect(await readIssue(unrelatedDone)).toMatchObject({
      status: "done",
      executionWorkspaceId: seed.executionWorkspaceId,
    });
  }, 30_000);

  it("leaves a shared project workspace co-tenant bound when the source issue closes", async () => {
    const seed = await seedWorkspace({ strategyType: "project_primary" });
    const unrelated = await bindTenant({ ...seed, title: "Shared repo root co-tenant" });

    await svc.update(seed.sourceIssueId, { status: "done" });

    expect(await readIssue(unrelated)).toMatchObject({
      executionWorkspaceId: seed.executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
  }, 30_000);

  it("refuses to adopt a finished issue's worktree inherited through a co-tenant parent", async () => {
    const seed = await seedWorkspace();
    const parent = await bindTenant({ ...seed, title: "Co-tenant parent" });
    // Close the source issue without the close-time re-examination, which is
    // the state every binding made before that guard existed is already in.
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(issues.id, seed.sourceIssueId));

    const followUp = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      parentId: parent,
      title: "Follow-up filed after the source issue closed",
    });

    expect(followUp.executionWorkspaceId).toBeNull();
    // Project context still carries over; only the frozen checkout does not.
    expect(followUp.projectId).toBe(seed.projectId);
  }, 30_000);

  it("refuses to adopt a finished issue's worktree named directly by an inheritance source", async () => {
    const seed = await seedWorkspace();
    await db
      .update(issues)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(issues.id, seed.sourceIssueId));

    const followUp = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      title: "Follow-up naming the finished issue",
      inheritExecutionWorkspaceFromIssueId: seed.sourceIssueId,
    });

    expect(followUp.executionWorkspaceId).toBeNull();
  }, 30_000);

  it("still inherits a live parent's worktree", async () => {
    const seed = await seedWorkspace();

    const child = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      parentId: seed.sourceIssueId,
      title: "Subtask of a live parent",
    });

    expect(child.executionWorkspaceId).toBe(seed.executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
  }, 30_000);

  it("still inherits a live source issue's worktree through an unrelated co-tenant parent", async () => {
    const seed = await seedWorkspace();
    // The dominant legal case: an issue outside the source subtree is working in
    // the worktree while the source issue is still open, and files a subtask.
    const coTenantParent = await bindTenant({ ...seed, title: "Live co-tenant parent" });

    const child = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      parentId: coTenantParent,
      title: "Subtask of a live co-tenant",
    });

    expect(child.executionWorkspaceId).toBe(seed.executionWorkspaceId);
  }, 30_000);

  it("keeps the source issue's own binding when a closed workspace releases its leases", async () => {
    const seed = await seedWorkspace();
    const unrelated = await bindTenant({ ...seed, title: "Unrelated co-tenant" });
    await db
      .update(executionWorkspaces)
      .set({ status: "archived", cleanupReason: "manual" })
      .where(eq(executionWorkspaces.id, seed.executionWorkspaceId));

    const cleared = await clearWorkspaceBindingsForClosedWorkspace(db, {
      companyId: seed.companyId,
      workspaceId: seed.executionWorkspaceId,
      sourceIssueId: seed.sourceIssueId,
      actor: { actorType: "system", actorId: "test" },
      reason: "workspace_archived",
    });

    expect(cleared.map((binding) => binding.issueId)).toEqual([unrelated]);
    // A live source issue can still reopen its own workspace, so it keeps the
    // pointer that reopen needs.
    expect(await readIssue(seed.sourceIssueId)).toMatchObject({
      executionWorkspaceId: seed.executionWorkspaceId,
    });
    expect(await readIssue(unrelated)).toMatchObject({ executionWorkspaceId: null });
  }, 30_000);

  it("still inherits the worktree of a finished issue inside its own subtree", async () => {
    const seed = await seedWorkspace();
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(issues.id, seed.sourceIssueId));

    const child = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      parentId: seed.sourceIssueId,
      title: "Subtask of the finished source issue",
    });

    expect(child.executionWorkspaceId).toBe(seed.executionWorkspaceId);
  }, 30_000);
  // A closed workspace has no directory left to share, whatever its strategy and
  // whoever asks. Both closed states are covered separately, because one literal
  // can be dropped without touching the other.
  it("refuses to adopt an archived workspace even from a live parent", async () => {
    const seed = await seedWorkspace({ workspaceStatus: "archived" });

    const child = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      parentId: seed.sourceIssueId,
      title: "Subtask of a live parent whose workspace is archived",
    });

    expect(child.executionWorkspaceId).toBeNull();
  }, 30_000);

  it("refuses to adopt a cleanup_failed workspace even from a live parent", async () => {
    const seed = await seedWorkspace({ workspaceStatus: "cleanup_failed" });

    const child = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      parentId: seed.sourceIssueId,
      title: "Subtask of a live parent whose workspace failed cleanup",
    });

    expect(child.executionWorkspaceId).toBeNull();
  }, 30_000);

  // The branch-pinned carve-out has to discriminate. A shared repository root is
  // meant to hold many issues and its branch keeps moving, so a finished source
  // issue says nothing about it and it stays inheritable.
  it("still inherits a shared project workspace whose source issue has finished", async () => {
    const seed = await seedWorkspace({ strategyType: "project_primary" });
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(issues.id, seed.sourceIssueId));

    const followUp = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      title: "Follow-up on a shared repo root",
      inheritExecutionWorkspaceFromIssueId: seed.sourceIssueId,
    });

    expect(followUp.executionWorkspaceId).toBe(seed.executionWorkspaceId);
  }, 30_000);

  // A worktree with no recorded source issue has no close event to go stale at,
  // so there is nothing to refuse.
  it("still inherits a worktree that records no source issue", async () => {
    const seed = await seedWorkspace({ attachSourceIssue: false, sourceStatus: "done" });

    const followUp = await svc.create(seed.companyId, {
      projectId: seed.projectId,
      title: "Follow-up on a sourceless worktree",
      inheritExecutionWorkspaceFromIssueId: seed.sourceIssueId,
    });

    expect(followUp.executionWorkspaceId).toBe(seed.executionWorkspaceId);
  }, 30_000);
  // Acceptance criterion 3, and the predicate the CTO asked to be written down.
  // The LAC-5148 sweep counted "22" under three conditions that lived only in
  // the person running it: the workspace is a git worktree, the workspace record
  // is still active, and the workspace's source issue has finished. Drop the
  // strategy condition and 400+ shared repository roots join the count, which
  // are not the defect. Drop the active condition and archived workspaces whose
  // directory is already deleted join it, which are a different shape. The count
  // means nothing without all three, so the sweep lives here as a test.
  const GENERALIZED_SWEEP = sql`
    WITH RECURSIVE source_subtree(root_id, id) AS (
      SELECT source.id, source.id
      FROM issues source
      WHERE source.status IN ('done', 'cancelled')
      UNION ALL
      SELECT parent.root_id, child.id
      FROM issues child
      JOIN source_subtree parent ON child.parent_id = parent.id
    )
    SELECT
      tenant.id AS tenant_id,
      CASE WHEN subtree.id IS NULL THEN 'UNRELATED' ELSE 'DESCENDANT' END AS verdict
    FROM issues tenant
    JOIN execution_workspaces workspace
      ON workspace.id = tenant.execution_workspace_id
    JOIN issues source
      ON source.id = workspace.source_issue_id
    LEFT JOIN source_subtree subtree
      ON subtree.root_id = source.id AND subtree.id = tenant.id
    WHERE workspace.strategy_type = 'git_worktree'
      AND workspace.status = 'active'
      AND source.status IN ('done', 'cancelled')
      AND tenant.status NOT IN ('done', 'cancelled')
      AND tenant.id <> source.id
  `;

  it("leaves the generalized sweep with only DESCENDANT rows after a mixed-tenant close", async () => {
    const seed = await seedWorkspace();
    const child = await bindTenant({ ...seed, parentId: seed.sourceIssueId, status: "todo", title: "Descendant subtask" });
    const unrelated = await bindTenant({ ...seed, title: "Unrelated co-tenant" });

    const before = await db.execute(GENERALIZED_SWEEP);
    const beforeRows = (before as unknown as { rows: Array<{ tenant_id: string; verdict: string }> }).rows ?? before;
    // Nothing is in scope yet: the source issue is live, so every lease is legal.
    expect((beforeRows as Array<{ tenant_id: string }>).filter((row) =>
      row.tenant_id === child || row.tenant_id === unrelated)).toEqual([]);

    await svc.update(seed.sourceIssueId, { status: "done" });

    const after = await db.execute(GENERALIZED_SWEEP);
    const afterRows = ((after as unknown as { rows: Array<{ tenant_id: string; verdict: string }> }).rows ?? after) as Array<{ tenant_id: string; verdict: string }>;
    const scoped = afterRows.filter((row) => row.tenant_id === child || row.tenant_id === unrelated);
    expect(scoped).toEqual([{ tenant_id: child, verdict: "DESCENDANT" }]);
  }, 30_000);
});
