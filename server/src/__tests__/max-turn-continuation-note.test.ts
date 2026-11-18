import { describe, expect, it } from "vitest";
import {
  buildMaxTurnContinuationNote,
  readMaxTurnContinuationForWake,
  MAX_TURN_CONTINUATION_WAKE_REASON,
} from "../services/heartbeat.js";

const note = buildMaxTurnContinuationNote({ attempt: 2, maxAttempts: 3, sourceRunId: "run-prev" });

describe("max-turn continuation note (LAC-8577)", () => {
  it("carries attempt, cap, source run and the not-a-blocker instruction", () => {
    expect(note).toMatchObject({ attempt: 2, maxAttempts: 3, sourceRunId: "run-prev", state: "max_turns_exhausted" });
    expect(note.instruction).toContain("died at the turn cap");
    expect(note.instruction).toContain("not a blocker");
  });

  it("surfaces on the cap wake reason with the attempt number", () => {
    const out = readMaxTurnContinuationForWake({ wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON, maxTurnContinuation: note });
    expect(out).toMatchObject({ attempt: 2, maxAttempts: 3, sourceRunId: "run-prev" });
    expect(out?.instruction).toContain("died at the turn cap");
  });

  it.each(["transient_failure_retry", "workspace_busy_retry", "issue_assigned"])(
    "does not claim a cap death on %s even when the snapshot carries a stale note",
    (wakeReason) => {
      expect(readMaxTurnContinuationForWake({ wakeReason, maxTurnContinuation: note })).toBeNull();
    },
  );

  it("renders nothing on the cap wake when no note exists", () => {
    expect(readMaxTurnContinuationForWake({ wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON })).toBeNull();
  });
});
