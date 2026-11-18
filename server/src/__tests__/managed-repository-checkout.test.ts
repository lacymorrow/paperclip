import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored, readManagedRepositoryPreparationFailure } from "../services/managed-repository-checkout.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-repository-publication-"));
  directories.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  await execFile("git", ["init", "--initial-branch=main", source]);
  await writeFile(path.join(source, "source.txt"), "initial\n");
  await execFile("git", ["-C", source, "add", "."]);
  await execFile("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
  return { root, source, target: path.join(root, "target") };
}
describe("atomic managed repository publication", () => {
  it("keeps managed repositories separate without requiring Git or touching an ancestor", async () => {
    const { source, target } = await fixture();
    await mkdir(target);
    await expect(ensureManagedRepositoriesIgnored(target)).resolves.toBeUndefined();
    const nestedPlainRoot = path.join(source, "plain-task");
    await mkdir(nestedPlainRoot);
    const original = await readFile(path.join(source, ".git", "info", "exclude"), "utf8");
    await ensureManagedRepositoriesIgnored(nestedPlainRoot);
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toBe(original);
    await ensureManagedRepositoriesIgnored(source);
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toContain("/.paperclip-repositories/");
  });
  it("allows a declared plain task directory with inert Git metadata without changing its files", async () => {
    const { target } = await fixture();
    await mkdir(path.join(target, ".git", "info"), { recursive: true });
    const file = path.join(target, ".git", "info", "exclude");
    await writeFile(file, "/.paperclip-repositories/\n");
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).resolves.toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("/.paperclip-repositories/\n");
    await expect(ensureManagedRepositoriesIgnored(target)).rejects.toThrow("not a git repository");
  });
  it("still excludes managed repositories when a task directory contains a real checkout", async () => {
    const { source } = await fixture();
    await ensureManagedRepositoriesIgnored(source, { plainTaskDirectory: true });
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toContain("/.paperclip-repositories/");
  });
  it("retains unexpected Git errors for declared plain task directories", async () => {
    const { root, target } = await fixture();
    await mkdir(path.join(target, ".git"), { recursive: true });
    vi.stubEnv("PATH", path.join(root, "missing-git"));
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects linked Git metadata even for a declared plain task directory", async () => {
    const { source, target } = await fixture();
    await mkdir(target);
    await symlink(path.join(source, ".git"), path.join(target, ".git"), "dir");
    const original = await readFile(path.join(source, ".git", "info", "exclude"), "utf8");
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).rejects.toThrow("must not be a symlink");
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toBe(original);
  });
  it.each([
    { label: "timeout", code: null, killed: true, timedOut: true },
    { label: "filesystem", code: "EACCES", killed: false, timedOut: false },
    { label: "output limit", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, timedOut: false },
  ])("retains safe $label metadata without adding raw command causes", async ({ code, killed, timedOut }) => {
    const { source, target } = await fixture();
    const original = Object.assign(new Error("Git failed for https://user:fixture-password@example.test/repo.git"), {
      code, killed, stderr: "private command output",
    });
    const failure = await materializeManagedProjectWorkspace(target, {
      repoUrl: "https://example.test/repo.git", localSource: source,
      beforePublish: async () => { throw original; },
    }).then(() => { throw new Error("Expected preparation to fail"); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(readManagedRepositoryPreparationFailure(failure)).toEqual({ code, timedOut });
    expect(failure).not.toHaveProperty("code");
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("stderr");
    expect(JSON.stringify(failure)).toBe("{}");
    expect((failure as Error).message).not.toContain("fixture-password");
    expect(await stat(target).catch(() => null)).toBeNull();
  });

  it("writes the pinned receipt inside the clone before making it visible", async () => {
    const { source, target } = await fixture();
    const result = await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source, beforePublish: async clone => {
      expect(await stat(target).catch(() => null)).toBeNull();
      const commit = (await execFile("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(clone, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ repositoryId: "receipt", pinnedCommit: commit }));
    } });
    expect(result.warning).toBeNull();
    expect(JSON.parse(await readFile(path.join(target, ".git", "paperclip-workspace-owner.json"), "utf8"))).toMatchObject({ repositoryId: "receipt", pinnedCommit: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(await readFile(path.join(target, "source.txt"), "utf8")).toBe("initial\n");
  });
  it("authorizes the empty staging root before copying any source bytes", async () => {
    const { root, source, target } = await fixture();
    let stagingChecked = false;
    await expect(materializeManagedProjectWorkspace(target, {
      repoUrl: source,
      beforeCopy: async staging => {
        expect(await readdir(staging)).toEqual([]);
        expect(await stat(target).catch(() => null)).toBeNull();
        stagingChecked = true;
        throw new Error("Private staging source denied");
      },
    })).rejects.toThrow("Private staging source denied");
    expect(stagingChecked).toBe(true);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
  it("does not publish an incomplete checkout when its receipt cannot be committed", async () => {
    const { root, source, target } = await fixture();
    await expect(materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source, beforePublish: async () => { throw new Error("receipt failed"); } })).rejects.toThrow(/receipt failed/);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
});

describe("managed checkout source overlay", () => {
  const STATE_PAYLOADS = [
    { label: "Paperclip's own per-issue worktrees", stateDir: ".paperclip/worktrees", payload: ".paperclip/worktrees/task-0/node_modules/payload.txt" },
    { label: "a managed repositories directory below the root", stateDir: "vendored/.paperclip-repositories", payload: "vendored/.paperclip-repositories/clone-abc123/node_modules/payload.txt" },
    { label: "a runtime directory below the root", stateDir: "vendored/.paperclip-runtime", payload: "vendored/.paperclip-runtime/session/payload.txt" },
  ];
  async function sourceWithLocalState() {
    const { source, target } = await fixture();
    // Untracked, un-ignored working-tree state. The overlay sees these because
    // `git ls-files --others --ignored` cannot classify anything inside a
    // nested checkout, so they arrive as ordinary content to copy.
    for (const { payload } of STATE_PAYLOADS) {
      await mkdir(path.join(source, path.dirname(payload)), { recursive: true });
      await writeFile(path.join(source, payload), "build output\n");
    }
    await writeFile(path.join(source, "uncommitted.txt"), "local\n");
    await writeFile(path.join(source, "vendored", "keep.txt"), "local\n");
    // A repository is allowed to carry its own `.paperclip` configuration. The
    // exclusion names the generated subdirectories, not the whole directory.
    await writeFile(path.join(source, ".paperclip", "config.json"), "{}\n");
    return { source, target };
  }

  it.each(STATE_PAYLOADS)("leaves $label out of a prepared checkout", async ({ stateDir, payload }) => {
    const { source, target } = await sourceWithLocalState();
    expect((await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source })).warning).toBeNull();
    expect(await stat(path.join(target, payload)).catch(() => null)).toBeNull();
    expect(await stat(path.join(target, stateDir)).catch(() => null)).toBeNull();
    expect(await readFile(path.join(source, payload), "utf8")).toBe("build output\n");
  });

  it("still overlays ordinary untracked work, including beside an excluded state directory", async () => {
    const { source, target } = await sourceWithLocalState();
    await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source });
    expect(await readFile(path.join(target, "uncommitted.txt"), "utf8")).toBe("local\n");
    expect(await readFile(path.join(target, "vendored", "keep.txt"), "utf8")).toBe("local\n");
    expect(await readFile(path.join(target, ".paperclip", "config.json"), "utf8")).toBe("{}\n");
    expect(await readFile(path.join(target, "source.txt"), "utf8")).toBe("initial\n");
  });

  it("leaves a worktree under a configured parent directory out of a prepared checkout", async () => {
    const { source, target } = await sourceWithLocalState();
    // `worktreeParentDir` is configurable, so Paperclip's execution worktrees do
    // not always sit under `.paperclip`. This one is an ordinary untracked
    // directory beside the source files, which is what the overlay walks.
    const worktree = path.join(source, "agent-worktrees", "task-1");
    await execFile("git", ["-C", source, "worktree", "add", "-b", "task-1", worktree]);
    await mkdir(path.join(worktree, "node_modules"), { recursive: true });
    await writeFile(path.join(worktree, "node_modules", "payload.txt"), "build output\n");

    expect((await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source })).warning).toBeNull();
    expect(await stat(path.join(target, "agent-worktrees", "task-1")).catch(() => null)).toBeNull();
    // The parent directory is ordinary untracked content and can hold anything, so
    // the exclusion names the worktree and leaves an empty directory behind.
    expect(await readdir(path.join(target, "agent-worktrees"))).toEqual([]);
    // The overlay reads the source folder, so the worktree itself survives.
    expect(await readFile(path.join(worktree, "node_modules", "payload.txt"), "utf8")).toBe("build output\n");
    expect(await readFile(path.join(target, "uncommitted.txt"), "utf8")).toBe("local\n");
  });

  it("still overlays a plain directory that only looks like a worktree parent", async () => {
    const { source, target } = await sourceWithLocalState();
    // The exclusion comes from what Git reports as a linked worktree, not from a
    // directory name, so ordinary untracked work keeps reaching the checkout.
    await mkdir(path.join(source, "agent-worktrees", "task-1"), { recursive: true });
    await writeFile(path.join(source, "agent-worktrees", "task-1", "notes.txt"), "local\n");
    await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source });
    expect(await readFile(path.join(target, "agent-worktrees", "task-1", "notes.txt"), "utf8")).toBe("local\n");
  });
  it("keeps the files of a registered worktree whose .git link is gone", async () => {
    const { source, target } = await sourceWithLocalState();
    // A half-cleaned worktree is still listed by Git but holds no Git metadata. It
    // is ordinary directory content and may hold uncommitted work, so it must reach
    // the prepared checkout rather than be treated as a worktree to leave out.
    const worktree = path.join(source, "agent-worktrees", "task-2");
    await execFile("git", ["-C", source, "worktree", "add", "-b", "task-2", worktree]);
    await writeFile(path.join(worktree, "unsaved.txt"), "real work\n");
    await rm(path.join(worktree, ".git"));
    await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source });
    expect(await readFile(path.join(target, "agent-worktrees", "task-2", "unsaved.txt"), "utf8")).toBe("real work\n");
  });

  it("prepares a checkout when a registered worktree directory no longer exists", async () => {
    const { source, target } = await sourceWithLocalState();
    const worktree = path.join(source, "agent-worktrees", "task-3");
    await execFile("git", ["-C", source, "worktree", "add", "-b", "task-3", worktree]);
    await rm(worktree, { recursive: true, force: true });
    expect((await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source })).warning).toBeNull();
    expect(await readFile(path.join(target, "uncommitted.txt"), "utf8")).toBe("local\n");
  });

  it("leaves a registered worktree out when the source is reached through a symlink", async () => {
    const { source, target } = await sourceWithLocalState();
    const worktree = path.join(source, "agent-worktrees", "task-4");
    await execFile("git", ["-C", source, "worktree", "add", "-b", "task-4", worktree]);
    const alias = path.join(path.dirname(source), "source-alias");
    await symlink(source, alias);
    await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: alias });
    expect(await stat(path.join(target, "agent-worktrees", "task-4")).catch(() => null)).toBeNull();
    expect(await readFile(path.join(target, "uncommitted.txt"), "utf8")).toBe("local\n");
  });
});
