import { describe, expect, it } from 'vitest';
import { findConflicts } from '@app/shortcuts';

describe('shortcut conflicts', () => {
  it('reports keys bound by more than one command, normalised', () => {
    const conflicts = findConflicts([
      { key: 'Mod+S', command: 'file.save' },
      { key: 'mod+shift+p', command: 'app.commandPalette' },
      { key: 'Shift+Mod+P', command: 'other.palette' },
      { key: 'Mod+S', command: 'file.save' },
      { key: 'mod+s', command: 'sign.sign' },
    ]);
    expect(conflicts).toHaveLength(2);
    const byKey = new Map(conflicts.map((c) => [c.key, c.commands]));
    expect(byKey.get('Mod+Shift+P')).toEqual(['app.commandPalette', 'other.palette']);
    expect(byKey.get('Mod+S')).toEqual(['file.save', 'sign.sign']);
  });

  it('is empty when every key is unique', () => {
    expect(
      findConflicts([
        { key: 'F6', command: 'a' },
        { key: 'Shift+F6', command: 'b' },
      ]),
    ).toEqual([]);
  });
});

/**
 * The real app, not a hand-written list: every manifest the renderer registers, together. A
 * module that quietly takes a key another one already had is exactly the bug `findConflicts`
 * exists for, and nothing was checking the app's own set until M12 added six more keys.
 */
describe('the shortcuts the app actually registers', () => {
  it('no two commands claim the same key', async () => {
    const { Registry } = await import('@core/Registry');
    const registry = new Registry();
    for (const path of [
      '@modules/M00-scaffold/manifest',
      '@modules/M01-theme-system/manifest',
      '@modules/M02-app-shell/manifest',
      '@modules/M10-engine-layer/manifest',
      '@modules/M11-viewer/manifest',
      '@modules/M12-navigation-panels/manifest',
      '@modules/M20-document-model/manifest',
      '@modules/M21-save/manifest',
    ]) {
      const module = (await import(/* @vite-ignore */ path)) as { default: never };
      registry.register(module.default);
    }
    expect(findConflicts(registry.allShortcuts())).toEqual([]);
  });
});
