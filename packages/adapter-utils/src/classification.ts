import { parseJson } from "./server-utils.js";

/**
 * Drops JSONL event lines (stream events, structured results, and — critically
 * — the agent conversation embedded inside them) from raw CLI stdout, keeping
 * only plain-text lines such as CLI diagnostics and login prompts.
 *
 * Keyword error classifiers must never see the agent conversation: assistant
 * text routinely discusses rate limits, auth, sessions, and retries, and
 * matching it mis-coded successful or unrelated runs as transient/auth
 * failures, chaining full-cost retries (LAC-2760 failure mode).
 */
export function stripJsonlEventLines(stdout: string | null | undefined): string {
  if (!stdout) return "";
  return stdout
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (!trimmed.startsWith("{")) return true;
      return parseJson(trimmed) == null;
    })
    .join("\n");
}

/**
 * Builds the haystack keyword error classifiers are allowed to scan:
 * adapter-extracted structured error text, plain-text (non-JSONL) stdout, and
 * stderr. Stripping JSONL event lines happens here, inside the builder, so the
 * "never scan the conversation" invariant is mechanism rather than a
 * per-call-site convention — passing raw stream stdout is safe.
 */
export function buildErrorClassificationHaystack(input: {
  errorMessage?: string | null;
  stdout?: string | null;
  stderr?: string | null;
}): string {
  return [input.errorMessage ?? "", stripJsonlEventLines(input.stdout), input.stderr ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}
