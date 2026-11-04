import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_SRC = path.resolve(import.meta.dirname, "..");

/**
 * `blockedTransitionAt` is what the rest of the platform reads to know an issue
 * is parked and for how long: `routable-blocked` will not deliver an
 * `issue_unblock_requested` wake without it, the idle-work proof needs it, and
 * the dependency-ready wake key is stamped with it. A writer that sets
 * `status: "blocked"` straight on the table and skips the timestamp creates a
 * park nothing downstream can see (90 of 242 blocked issues on one instance).
 *
 * `issueService.update` stamps it, so the rule is: either go through the
 * service, or set the column in the same `.set({ ... })`.
 */
const REQUIRED_WITH_BLOCKED_STATUS = "blockedTransitionAt";

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") return [];
        return listSourceFiles(full);
      }
      if (!entry.name.endsWith(".ts")) return [];
      if (entry.name.endsWith(".test.ts")) return [];
      return [full];
    }),
  );
  return files.flat();
}

/** Extract the body of every `.update(issues).set({ ... })` call in `source`. */
function issueUpdateSetBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = ".update(issues)";
  let cursor = source.indexOf(marker);
  while (cursor !== -1) {
    const setStart = source.indexOf(".set({", cursor);
    // `.set({` has to be the next call on the chain, not one from a later
    // statement. Anything past the following `;` belongs to another statement.
    const statementEnd = source.indexOf(";", cursor);
    if (setStart !== -1 && (statementEnd === -1 || setStart < statementEnd)) {
      let depth = 0;
      let index = setStart + ".set(".length;
      const bodyStart = index + 1;
      for (; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      bodies.push(source.slice(bodyStart, index));
    }
    cursor = source.indexOf(marker, cursor + marker.length);
  }
  return bodies;
}

describe("every raw writer of status blocked stamps the transition", () => {
  it("sets blockedTransitionAt in the same update", async () => {
    const files = await listSourceFiles(SERVER_SRC);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!source.includes('status: "blocked"')) continue;
      for (const body of issueUpdateSetBodies(source)) {
        if (!body.includes('status: "blocked"')) continue;
        if (body.includes(REQUIRED_WITH_BLOCKED_STATUS)) continue;
        offenders.push(path.relative(SERVER_SRC, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
