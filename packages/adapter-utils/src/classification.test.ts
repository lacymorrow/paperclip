import { describe, expect, it } from "vitest";
import { buildErrorClassificationHaystack, stripJsonlEventLines } from "./classification.js";

describe("stripJsonlEventLines", () => {
  it("drops JSONL event lines and keeps plain-text lines", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "We hit a 429 rate limit; try again later." },
      }),
      "Please visit https://example.com/login to authenticate.",
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n");

    expect(stripJsonlEventLines(stdout)).toBe(
      "Please visit https://example.com/login to authenticate.",
    );
  });

  it("keeps lines that look like JSON but do not parse", () => {
    expect(stripJsonlEventLines('{ this is not json "rate limit"')).toBe(
      '{ this is not json "rate limit"',
    );
  });

  it("returns an empty string for null, undefined, and empty input", () => {
    expect(stripJsonlEventLines(null)).toBe("");
    expect(stripJsonlEventLines(undefined)).toBe("");
    expect(stripJsonlEventLines("")).toBe("");
  });
});

describe("buildErrorClassificationHaystack", () => {
  it("joins error message, plain-text stdout, and stderr", () => {
    const haystack = buildErrorClassificationHaystack({
      errorMessage: "structured failure",
      stdout: "plain diagnostic line\n",
      stderr: "stderr line",
    });
    expect(haystack).toBe("structured failure\nplain diagnostic line\nstderr line");
  });

  it("never includes JSONL conversation lines from stdout", () => {
    const haystack = buildErrorClassificationHaystack({
      errorMessage: null,
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "the upstream was overloaded, 429" }] },
        }),
        "cli: fatal error",
      ].join("\n"),
      stderr: "",
    });
    expect(haystack).toBe("cli: fatal error");
    expect(haystack).not.toContain("429");
  });

  it("drops blank lines and trims whitespace", () => {
    const haystack = buildErrorClassificationHaystack({
      stdout: "  padded  \n\n\n",
      stderr: "\n  err  \n",
    });
    expect(haystack).toBe("padded\nerr");
  });
});
