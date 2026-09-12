/** Explicit staging hook owned by the test harness. Never installed in an ordinary run. */
import { fileCapabilities } from './fs/capabilities';
import type { RecentFiles } from './recent';
import { allWindows } from './window';
export function installTestFileGrants(recent: RecentFiles): void {
  Object.assign(globalThis, {
    __ynotGrantTestPath(windowId: number, path: string, folder: boolean): string {
      if (!allWindows().some((win) => win.id === windowId)) throw new Error('No such test window');
      const selected = fileCapabilities.grant(windowId, path, ['read', 'write'], folder);
      if (!folder) recent.add(selected);
      return selected;
    },
  });
}
