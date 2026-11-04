import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

// Tool output the agent itself printed. It carries the literal phrase the
// model-not-found detector scans for, but the provider never returned it.
const POISONED_TOOL_OUTPUT =
  'execute.ts:1199: : failed && isClaudeModelNotFoundError({ ... ? "model_not_found"';

// Tool output the agent itself printed while probing an HTTP API. The
// login-prompt detector scans every stdout line for "unauthorized", so an
// agent that curls any authenticated route poisons it. Nothing about the
// Claude session is unauthenticated here.
const POISONED_LOGIN_TOOL_OUTPUT =
  "probe: GET /api/agents/me -> HTTP/1.1 401 Unauthorized";

function buildProcResult(resultEvent: Record<string, unknown>, extraStdout = "") {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      ...(extraStdout
        ? [
            JSON.stringify({
              type: "assistant",
              session_id: "claude-session-1",
              message: { content: [{ type: "text", text: extraStdout }] },
            }),
          ]
        : []),
      JSON.stringify({ type: "result", session_id: "claude-session-1", ...resultEvent }),
    ].join("\n"),
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockExecutionResult(result: ReturnType<typeof buildProcResult>) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version")
      ? { ...result, exitCode: 0, stdout: "2.1.284 (Claude Code)" }
      : result,
  );
}

function buildContext() {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local failure classification precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps max_turns_exhausted when stdout mentions model_not_found", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error_max_turns" }, POISONED_TOOL_OUTPUT),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("still reports model_not_found when the provider returns it", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error", result: "API Error: 404 model not found" }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("model_not_found");
  });

  // A run that reported error_max_turns executed its whole turn budget, which
  // only an authenticated session can do. Coding it claude_auth_required
  // renders "Error: not logged in to Claude" and routes an operator to
  // reconnect an account that is fine.
  it("keeps max_turns_exhausted when stdout mentions a login prompt", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error_max_turns" }, POISONED_LOGIN_TOOL_OUTPUT),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
    expect(result.resultJson?.stopReason).toBe("max_turns_exhausted");
  });

  // The token-failure marker is scoped to the parsed terminal fields, which on
  // a capped run are the agent's own last words. Narrow scope does not help
  // when the agent was working on authentication when the cap hit.
  it("keeps max_turns_exhausted when the capped run's own result text mentions an auth failure", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "error_max_turns",
        result: "Reached maximum number of turns (80). Last step: the probe returned authentication_failed, still debugging.",
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("still reports claude_auth_required when the session genuinely needs login", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "error",
        result: "Invalid bearer token. Please run `claude login`.",
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });
});
