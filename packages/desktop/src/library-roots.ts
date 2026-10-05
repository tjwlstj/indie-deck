import path from 'node:path';

/** Lexical containment only; discovery independently rejects junctions/links.
 * relative() handles a drive/share root without adding a second separator. */
export function withinLibraryRoots(
  target: string,
  roots: readonly string[],
  paths: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'> = path,
): boolean {
  const canonical = (value: string) => {
    const resolved = paths.resolve(value);
    return paths.sep === '\\' ? resolved.toLowerCase() : resolved;
  };
  const resolved = canonical(target);
  return roots.some((root) => {
    const relative = paths.relative(canonical(root), resolved);
    return relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
  });
}
