import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dependency-ready unblock tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("resolved dependency wake backstop unblocks the dependent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dependency-unblock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockTelemetryClient.track.mockClear();
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * One `done_but_blocking` shape: a blocker that reached `done` and a
   * dependent that is still `blocked` behind the live `blocks` edge.
   */
  async function seedDoneButBlocking(
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Blocker that finished",
        status: "done",
        assigneeAgentId: agentId,
      },
      {
        id: dependentIssueId,
        companyId,
        title: "Dependent that nobody moved",
        status: "blocked",
        assigneeAgentId: agentId,
        // Set well in the past so the self-block activity window is empty.
        blockedTransitionAt: new Date(Date.now() - 3 * DAY_MS),
        ...overrides,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });

    return { companyId, agentId, blockerIssueId, dependentIssueId };
  }

  function backstop(enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }))) {
    return {
      enqueueWakeup,
      run: (companyId: string) =>
        recoveryService(db, { enqueueWakeup: enqueueWakeup as never })
          .reconcileResolvedDependencyWakeBackstop({ companyId }),
    };
  }

  async function readStatus(issueId: string) {
    return db
      .select({
        status: issues.status,
        blockedTransitionAt: issues.blockedTransitionAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
  }

  it("moves a dependent out of blocked once every blocker is done", async () => {
    const { companyId, dependentIssueId } = await seedDoneButBlocking();
    const harness = backstop();

    const result = await harness.run(companyId);

    expect(result.unblocked).toBe(1);
    const dependent = await readStatus(dependentIssueId);
    expect(dependent.status).toBe("todo");
    expect(dependent.blockedTransitionAt).toBeNull();
    expect(harness.enqueueWakeup).toHaveBeenCalledTimes(1);

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.dependency_ready_unblocked"))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.dependency_ready_unblocked");
    expect((audit?.details as { previousStatus?: string } | null)?.previousStatus).toBe("blocked");

    const comment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, dependentIssueId))
      .then((rows) => rows[0]);
    expect(comment?.body).toContain("no longer blocked");
  });

  it("retries a dependent whose only prior wake already completed", async () => {
    const { companyId, agentId, dependentIssueId } = await seedDoneButBlocking();
    // A wake that ran and changed nothing. Before the fix this suppressed every
    // later attempt for the life of the blocked cycle, so the dependent parked.
    const { buildIssueBlockersResolvedWakeStateKey } = await import(
      "../services/issue-dependency-wakeups.ts"
    );
    const { blockerIssueId } = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, dependentIssueId))
      .then((rows) => rows[0]!);
    const dependent = await readStatus(dependentIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      status: "completed",
      payload: { issueId: dependentIssueId },
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
        blockedTransitionAt: dependent.blockedTransitionAt,
      }),
      requestedAt: new Date(Date.now() - 2 * DAY_MS),
      finishedAt: new Date(Date.now() - 2 * DAY_MS),
    });

    const result = await backstop().run(companyId);

    expect(result.unblocked).toBe(1);
    expect((await readStatus(dependentIssueId)).status).toBe("todo");
  });

  it("retries a dependent stranded behind a wake queued over a day ago", async () => {
    const { companyId, agentId, dependentIssueId } = await seedDoneButBlocking();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "queued",
      payload: { issueId: dependentIssueId },
      requestedAt: new Date(Date.now() - 2 * DAY_MS),
    });

    const result = await backstop().run(companyId);

    expect(result.livePathSkipped).toBe(0);
    expect(result.unblocked).toBe(1);
    expect((await readStatus(dependentIssueId)).status).toBe("todo");
  });

  it("still defers to a wake queued moments ago", async () => {
    const { companyId, agentId, dependentIssueId } = await seedDoneButBlocking();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "queued",
      payload: { issueId: dependentIssueId },
      requestedAt: new Date(),
    });

    const result = await backstop().run(companyId);

    expect(result.livePathSkipped).toBe(1);
    expect(result.unblocked).toBe(0);
    expect((await readStatus(dependentIssueId)).status).toBe("blocked");
  });

  it("leaves a park that an unblock descriptor owns alone", async () => {
    const { companyId, dependentIssueId } = await seedDoneButBlocking({
      unblockDescriptor: { owner: "board", action: "approve the spend" },
    });

    const result = await backstop().run(companyId);

    expect(result.unblocked).toBe(0);
    expect(result.unblockSkipped).toBe(1);
    expect((await readStatus(dependentIssueId)).status).toBe("blocked");
  });

  it("leaves a park that an open recovery action owns alone", async () => {
    const { companyId, dependentIssueId } = await seedDoneButBlocking();
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: dependentIssueId,
      kind: "stranded_issue",
      status: "active",
      cause: "test_fixture",
      fingerprint: randomUUID(),
      nextAction: "wait for the owner",
    });

    const result = await backstop().run(companyId);

    expect(result.unblocked).toBe(0);
    expect(result.unblockSkipped).toBe(1);
    expect((await readStatus(dependentIssueId)).status).toBe("blocked");
  });
});
