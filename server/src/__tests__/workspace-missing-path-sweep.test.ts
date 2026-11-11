import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
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
import {
  executionWorkspaceService,
  setMetadataReopenPendingConsumption,
} from "../services/execution-workspaces.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// A git worktree workspace whose recorded directory is gone cannot be validated,
// so every issue the runtime sends there parks instead of working. `active` is
// exactly the state the close-time and create-time guards of LAC-7280 treat as
// healthy, and no board event ever fires for a directory that disappeared, so
// nothing reaches these rows. These tests cover the sweep that does.
//
// The sweep is instance-wide, so every assertion below reads the state of the
// row it seeded rather than a whole-sweep count. A row another test seeded is a
// legitimate candidate, so counts are not comparable across tests.
describeEmbeddedPostgres("missing-path worktree workspace sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const scratchDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-missing-path-sweep-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, 60_000);

  afterAll(async () => {
    for (const dir of scratchDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function makeRealDirectory() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-missing-path-real-"));
    scratchDirs.push(dir);
    return dir;
  }

  async function readWorkspace(id: string) {
    return await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, id))
      .then((rows) => rows[0]!);
  }

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
    workspaceStatus?: string;
    cwd?: string | null;
    providerRef?: string | null;
    metadata?: Record<string, unknown> | null;
  } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      cwd: options.cwd === undefined ? `/tmp/paperclip-missing-path-${executionWorkspaceId}` : options.cwd,
      providerRef: options.providerRef ?? null,
      branchName: "source-branch",
      metadata: options.metadata ?? null,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      title: "Source issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { companyId, projectId, executionWorkspaceId, sourceIssueId };
  }

  async function bindTenant(input: {
    companyId: string;
    projectId: string;
    executionWorkspaceId: string;
    status?: string;
    title: string;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      title: input.title,
      status: input.status ?? "in_progress",
      priority: "medium",
      executionWorkspaceId: input.executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    return id;
  }

  // AC1. The defect itself.
  it("takes an active worktree workspace whose recorded directory is gone out of active", async () => {
    const seed = await seedWorkspace();

    const result = await svc.sweepMissingPathWorktreeWorkspaces();

    expect(result.archivedWorkspaceIds).toContain(seed.executionWorkspaceId);
    const workspace = await readWorkspace(seed.executionWorkspaceId);
    expect(workspace.status).toBe("archived");
    expect(workspace.closedAt).not.toBeNull();
  }, 30_000);

  // AC2. The negative control on the path: the pass discriminates on whether the
  // directory is on disk, not on strategy, status or age.
  it("leaves an active worktree workspace whose directory is on disk alone", async () => {
    const cwd = await makeRealDirectory();
    const seed = await seedWorkspace({ cwd });

    const result = await svc.sweepMissingPathWorktreeWorkspaces();

    expect(result.archivedWorkspaceIds).not.toContain(seed.executionWorkspaceId);
    expect(await readWorkspace(seed.executionWorkspaceId)).toMatchObject({ status: "active", closedAt: null });
  }, 30_000);

  // AC3. The negative control on strategy, matching LAC-7280's carve-out: a
  // shared repository root is not branch-pinned and is not this class.
  it("leaves a project_primary workspace alone even when its recorded directory is gone", async () => {
    const seed = await seedWorkspace({ strategyType: "project_primary" });

    const result = await svc.sweepMissingPathWorktreeWorkspaces();

    expect(result.archivedWorkspaceIds).not.toContain(seed.executionWorkspaceId);
    expect(await readWorkspace(seed.executionWorkspaceId)).toMatchObject({ status: "active", closedAt: null });
  }, 30_000);

  // AC4. The unbind half, reusing LAC-7280's helper rather than a second
  // implementation: a co-tenant left bound here would ask a later run to restore
  // a directory that does not exist, which is the park this whole class causes.
  it("releases the non-terminal co-tenant leases when it leaves active", async () => {
    const seed = await seedWorkspace();
    const tenant = await bindTenant({ ...seed, title: "Co-tenant" });
    const finishedTenant = await bindTenant({ ...seed, status: "done", title: "Finished co-tenant" });

    const result = await svc.sweepMissingPathWorktreeWorkspaces();

    expect(result.archivedWorkspaceIds).toContain(seed.executionWorkspaceId);
    expect(await readIssue(tenant)).toMatchObject({
      status: "in_progress",
      executionWorkspaceId: null,
      executionWorkspacePreference: "isolated_workspace",
    });
    // The source issue keeps its binding: a reopen rebuilds this workspace for
    // the source issue and for no one else.
    expect(await readIssue(seed.sourceIssueId)).toMatchObject({
      executionWorkspaceId: seed.executionWorkspaceId,
    });
    // A finished tenant needs no workspace, so its recorded binding is history.
    expect(await readIssue(finishedTenant)).toMatchObject({
      status: "done",
      executionWorkspaceId: seed.executionWorkspaceId,
    });
  }, 30_000);

  // The negative control on the second recorded path. `provider_ref` tracks `cwd`
  // for a local worktree, so a row whose `cwd` is stale while its provider path
  // is still on disk has a directory to validate and is not this class.
  it("leaves a workspace alone when its provider path is still on disk", async () => {
    const providerRef = await makeRealDirectory();
    const seed = await seedWorkspace({ providerRef });

    const result = await svc.sweepMissingPathWorktreeWorkspaces();

    expect(result.archivedWorkspaceIds).not.toContain(seed.executionWorkspaceId);
    expect(await readWorkspace(seed.executionWorkspaceId)).toMatchObject({ status: "active", closedAt: null });
  }, 30_000);

  // The negative control on the recorded path being absent entirely. A row with
  // no `cwd` has no path to stat, so this pass has no evidence about it and a
  // different guard owns it.
  it("leaves a workspace with no recorded directory alone", async () => {
    const seed = await seedWorkspace({ cwd: null });

    const result = await svc.sweepMissingPathWorktreeWorkspaces();

    expect(result.archivedWorkspaceIds).not.toContain(seed.executionWorkspaceId);
    expect(await readWorkspace(seed.executionWorkspaceId)).toMatchObject({ status: "active", closedAt: null });
  }, 30_000);

  // The negative control on the archive path's own guard. A reopen published this
  // row as active and a caller will consume the rebuilt worktree, so routing
  // through the existing archive path means this pass refuses it too instead of
  // racing the rebuild.
  it("refuses a reopen-pending workspace, because it routes through the existing archive path", async () => {
    const seed = await seedWorkspace({
      metadata: setMetadataReopenPendingConsumption(null, new Date()),
    });

    const result = await svc.sweepMissingPathWorktreeWorkspaces();

    expect(result.archivedWorkspaceIds).not.toContain(seed.executionWorkspaceId);
    expect(result.skippedReopenPending).toBeGreaterThanOrEqual(1);
    expect(await readWorkspace(seed.executionWorkspaceId)).toMatchObject({ status: "active", closedAt: null });
  }, 30_000);

  // The negative control on status. `idle` and `in_review` are live states that
  // still own their directory and are reached by other guards; this pass is
  // scoped to the one state both LAC-7280 guards read as healthy.
  it("leaves a non-active worktree workspace alone", async () => {
    const seed = await seedWorkspace({ workspaceStatus: "idle" });

    const result = await svc.sweepMissingPathWorktreeWorkspaces();

    expect(result.archivedWorkspaceIds).not.toContain(seed.executionWorkspaceId);
    expect(await readWorkspace(seed.executionWorkspaceId)).toMatchObject({ status: "idle", closedAt: null });
  }, 30_000);

  // The cadence. This class has no board event at all, so the pass has to be
  // driven by the sweep that already ticks on a timer. The seeded source issue
  // is live, so the terminal reaper itself has no reason to touch this row: only
  // the missing-path pass can archive it.
  it("runs from the terminal workspace sweep, which is its cadence", async () => {
    const seed = await seedWorkspace();

    await svc.sweepTerminalWorkspaces(50, undefined, { compact: false, allowRemoteDeliveryChecks: false });

    expect(await readWorkspace(seed.executionWorkspaceId)).toMatchObject({ status: "archived" });
  }, 60_000);
});
