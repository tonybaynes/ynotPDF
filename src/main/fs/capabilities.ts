/** Per-window filesystem authority. See ADR 0025. No renderer-owned grant channel. */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export type FileAccess = 'read' | 'write';
interface Grant {
  path: string;
  folder: boolean;
  access: Set<FileAccess>;
}
export function canonicalPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 32768)
    throw new Error('An absolute file path is required');
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Error('A dangling file link cannot be used', { cause: error });
    } catch (leafError) {
      if ((leafError as NodeJS.ErrnoException).code !== 'ENOENT') throw leafError;
    }
    return join(realpathSync.native(dirname(path)), basename(path));
  }
}
export function containedBy(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
}
export class FileCapabilities {
  private readonly windows = new Map<number, Grant[]>();
  grant(windowId: number, path: string, access: ReadonlyArray<FileAccess>, folder = false): string {
    const canonical = canonicalPath(path);
    if (folder && !statSync(canonical).isDirectory())
      throw new Error('The chosen folder no longer exists');
    const grants = this.windows.get(windowId) ?? [];
    const existing = grants.find((g) => g.path === canonical && g.folder === folder);
    if (existing) for (const mode of access) existing.access.add(mode);
    else grants.push({ path: canonical, folder, access: new Set(access) });
    this.windows.set(windowId, grants);
    return canonical;
  }
  check(windowId: number, path: string, access: FileAccess, folder = false): string {
    const canonical = canonicalPath(path);
    const allowed = (this.windows.get(windowId) ?? []).some(
      (g) =>
        g.access.has(access) &&
        (g.folder ? containedBy(g.path, canonical) : !folder && g.path === canonical),
    );
    if (!allowed)
      throw new Error(
        'File access was not granted in this window. Choose the file or folder first.',
      );
    return canonical;
  }
  clear(windowId: number): void {
    this.windows.delete(windowId);
  }
}
export const fileCapabilities = new FileCapabilities();
