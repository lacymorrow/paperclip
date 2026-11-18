export function isRelativePathOrDescendant(relative: string, candidate: string): boolean {
  return relative === candidate || relative.startsWith(`${candidate}/`);
}

function pathContainsSegmentOrDescendant(relative: string, segment: string): boolean {
  return relative === segment ||
    relative.startsWith(`${segment}/`) ||
    relative.endsWith(`/${segment}`) ||
    relative.includes(`/${segment}/`);
}

/**
 * `excludePatternMatches` reads a pattern whose first or last segment is `*` as
 * "this path segment at any depth", and the grammar carries no escape form. A
 * literal path that happens to have that shape - a real directory named `*` at
 * its start or end - can therefore not be expressed as an exclusion at all:
 * used as a pattern it would also match unrelated siblings. A caller deriving a
 * pattern from a real path has to leave such a path out rather than widen the
 * exclusion.
 */
export function isReservedExcludePatternShape(pattern: string): boolean {
  return pattern.startsWith("*/") || pattern.endsWith("/*");
}

export function excludePatternMatches(relative: string, pattern: string): boolean {
  if (pattern.startsWith("*/") && pattern.endsWith("/*")) {
    return pathContainsSegmentOrDescendant(relative, pattern.slice(2, -2));
  }
  if (pattern.startsWith("*/")) {
    return pathContainsSegmentOrDescendant(relative, pattern.slice(2));
  }
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return relative.startsWith(`${base}/`);
  }
  return isRelativePathOrDescendant(relative, pattern);
}

/**
 * Sandbox providers stage transfer scratch at the workspace root as
 * `.paperclip-upload-<uuid>…` (see `buildWorkspaceTarExtractCommand` and the
 * Daytona/Kubernetes `SCRATCH_PREFIX`). A control-plane kill during a transfer
 * leaves it behind, and providers never export it. It is not workspace content.
 * The literal stays inline: this function is serialized into the sandbox
 * checkpoint helper.
 */
export function isSandboxTransferScratchPath(relative: string): boolean {
  return !relative.includes("/") && relative.startsWith(".paperclip-upload-");
}

export function shouldExcludePath(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => excludePatternMatches(relative, entry));
}
