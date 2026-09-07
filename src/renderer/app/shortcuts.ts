/**
 * Global keyboard dispatcher (M00). Translates keydown events into normalised shortcut keys
 * and runs the bound command. `editor`-scoped shortcuts are ignored while typing in inputs;
 * `global` ones always fire.
 */

import { keyFromEvent, type Registry } from '@core/Registry';

export function installShortcuts(registry: Registry, isMac: boolean): () => void {
  const handler = (e: KeyboardEvent): void => {
    const key = keyFromEvent(e, isMac);
    if (!key) return;
    const spec = registry.shortcutForKey(key);
    if (!spec) return;
    const target = e.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable === true;
    if (typing && spec.scope !== 'global') return;
    if (!registry.isEnabled(spec.command)) return;
    e.preventDefault();
    void registry.run(spec.command, spec.args ?? {}).catch((error: unknown) => {
      console.error(`shortcut ${key} → ${spec.command} failed`, error);
    });
  };
  window.addEventListener('keydown', handler);
  return () => {
    window.removeEventListener('keydown', handler);
  };
}
