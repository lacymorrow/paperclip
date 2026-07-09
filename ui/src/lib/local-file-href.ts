/**
 * Heuristic detection for hrefs that point at local filesystem paths (e.g.
 * `/Users/lmorrow/dev/docs/file.md`). The SPA router would otherwise read the
 * first segment as a company prefix and fail with "No company matches prefix".
 * The browser cannot open local files, so these render as plain text.
 *
 * Root matching is case-sensitive: the app always writes company routes with
 * an uppercase prefix (`/USERS/...`), so app-generated links keep working.
 * The router itself matches prefixes case-insensitively, so a hand-written
 * lowercase link to a company whose prefix equals one of these roots (e.g.
 * `/tmp/issues` for a company prefixed TMP) is treated as a file path — an
 * accepted trade-off, since local paths are far more common in issue text
 * than hand-lowercased company links.
 */
const LOCAL_FILE_PATH_ROOT_PATTERN =
  /^\/(?:Users|home|private|root|workspace|tmp|var|etc|usr|opt|mnt|srv|Volumes)(?:\/|$)/;

const WINDOWS_DRIVE_PATTERN = /^[a-z]:[\\/]/i;

export function isLocalFileHref(href: string | null | undefined): boolean {
  if (!href) return false;
  const value = href.trim();
  if (!value) return false;
  if (/^file:/i.test(value)) return true;
  if (value === "~" || value.startsWith("~/")) return true;
  if (WINDOWS_DRIVE_PATTERN.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  return LOCAL_FILE_PATH_ROOT_PATTERN.test(value);
}
