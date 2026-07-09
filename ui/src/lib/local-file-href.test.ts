import { describe, expect, it } from "vitest";
import { isLocalFileHref } from "./local-file-href";

describe("isLocalFileHref", () => {
  it("matches absolute macOS user paths", () => {
    expect(
      isLocalFileHref("/Users/lmorrow/dev/code/docs/branch-and-commit-conventions.md"),
    ).toBe(true);
  });

  it("matches common unix filesystem roots", () => {
    expect(isLocalFileHref("/home/lmorrow/notes.md")).toBe(true);
    expect(isLocalFileHref("/root/.claude/settings.json")).toBe(true);
    expect(isLocalFileHref("/workspace/repo/src/index.ts")).toBe(true);
    expect(isLocalFileHref("/private/tmp/report.txt")).toBe(true);
    expect(isLocalFileHref("/tmp/scratch.log")).toBe(true);
    expect(isLocalFileHref("/var/log/system.log")).toBe(true);
    expect(isLocalFileHref("/etc/hosts")).toBe(true);
    expect(isLocalFileHref("/usr/local/bin/paperclipai")).toBe(true);
    expect(isLocalFileHref("/opt/tools/run.sh")).toBe(true);
    expect(isLocalFileHref("/mnt/data/dump.sql")).toBe(true);
    expect(isLocalFileHref("/srv/www/index.html")).toBe(true);
    expect(isLocalFileHref("/media/usb/photo.jpg")).toBe(true);
    expect(isLocalFileHref("/Volumes/External/backup.zip")).toBe(true);
  });

  it("matches a bare filesystem root without a trailing segment", () => {
    expect(isLocalFileHref("/Users")).toBe(true);
    expect(isLocalFileHref("/tmp")).toBe(true);
  });

  it("matches file: URLs regardless of case", () => {
    expect(isLocalFileHref("file:///Users/lmorrow/doc.md")).toBe(true);
    expect(isLocalFileHref("FILE:///C:/temp/doc.md")).toBe(true);
  });

  it("matches home-relative paths", () => {
    expect(isLocalFileHref("~/dev/code/docs/file.md")).toBe(true);
    expect(isLocalFileHref("~")).toBe(true);
  });

  it("matches Windows drive and UNC paths", () => {
    expect(isLocalFileHref("C:\\Users\\lmorrow\\file.txt")).toBe(true);
    expect(isLocalFileHref("c:/Users/lmorrow/file.txt")).toBe(true);
    expect(isLocalFileHref("\\\\server\\share\\file.txt")).toBe(true);
  });

  it("ignores app routes and issue references", () => {
    expect(isLocalFileHref("/LAC/issues/LAC-1002")).toBe(false);
    expect(isLocalFileHref("/issues/LAC-1002")).toBe(false);
    expect(isLocalFileHref("/projects/abc")).toBe(false);
    expect(isLocalFileHref("/agents/123")).toBe(false);
  });

  it("does not collide with uppercase company prefixes", () => {
    // App-generated company links always use the uppercase prefix
    // (/USERS/...), so case-sensitive root matching leaves them clickable.
    expect(isLocalFileHref("/USERS/issues/USERS-1")).toBe(false);
    expect(isLocalFileHref("/HOME/issues/HOME-2")).toBe(false);
    expect(isLocalFileHref("/TMP/issues/TMP-3")).toBe(false);
  });

  it("ignores web URLs, relative paths, and fragments", () => {
    expect(isLocalFileHref("https://example.com/Users/lmorrow")).toBe(false);
    expect(isLocalFileHref("http://127.0.0.1:3100/BIZ/issues/BIZ-51")).toBe(false);
    expect(isLocalFileHref("docs/file.md")).toBe(false);
    expect(isLocalFileHref("./relative/path.md")).toBe(false);
    expect(isLocalFileHref("#section")).toBe(false);
    expect(isLocalFileHref("mailto:someone@example.com")).toBe(false);
  });

  it("ignores empty and missing values", () => {
    expect(isLocalFileHref(null)).toBe(false);
    expect(isLocalFileHref(undefined)).toBe(false);
    expect(isLocalFileHref("")).toBe(false);
    expect(isLocalFileHref("   ")).toBe(false);
  });
});
