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
