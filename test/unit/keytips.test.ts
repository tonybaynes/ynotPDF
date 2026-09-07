import { describe, expect, it } from 'vitest';
import { assignKeyTips, candidates, matchKeyTip } from '@app/ribbon/keytips';

describe('key tips', () => {
  it('prefers the first letter, then initials, then first+other letters', () => {
    expect(candidates('Home')[0]).toBe('H');
    expect(candidates('Save As').slice(0, 2)).toEqual(['S', 'SA']);
    expect(candidates('Zoom')).toContain('ZO');
  });

  it('assigns unique tips to tabs with Foxit-like labels', () => {
    const tabs = [
      'Home',
      'Edit',
      'Comment',
      'View',
      'Form',
      'Protect',
      'Organize',
      'Convert',
      'Accessibility',
      'Help',
    ].map((label) => ({ id: label.toLowerCase(), label }));
    const tips = assignKeyTips([{ id: 'file', label: 'File', keyTip: 'F' }, ...tabs]);
    const values = Array.from(tips.values());
    expect(new Set(values).size).toBe(values.length);
    expect(tips.get('file')).toBe('F');
    expect(tips.get('home')).toBe('H');
    // "Form" cannot take F (File has it) and "Help" cannot take H.
    expect(tips.get('form')).not.toBe('F');
    expect(tips.get('help')).not.toBe('H');
    // No one-letter tip is a prefix of a two-letter tip (typing would be ambiguous).
    for (const one of values.filter((v) => v.length === 1)) {
      expect(values.some((v) => v.length === 2 && v.startsWith(one))).toBe(false);
    }
  });

  it('honours explicit tips unless they collide, and falls back to digits', () => {
    const tips = assignKeyTips([
      { id: 'a', label: 'Alpha', keyTip: 'A' },
      { id: 'b', label: 'Alpha', keyTip: 'A' },
      { id: 'c', label: 'A' },
      { id: 'd', label: 'A' },
    ]);
    expect(tips.get('a')).toBe('A');
    expect(tips.get('b')).not.toBe('A');
    expect(new Set(tips.values()).size).toBe(4);
    expect(Array.from(tips.values()).some((v) => /^\d+$/.test(v))).toBe(true);
  });

  it('matches typed prefixes', () => {
    const tips = new Map([
      ['home', 'H'],
      ['saveAs', 'SA'],
      ['save', 'SV'],
    ]);
    expect(matchKeyTip('h', tips)).toEqual({ kind: 'match', id: 'home' });
    expect(matchKeyTip('S', tips)).toEqual({ kind: 'partial' });
    expect(matchKeyTip('sv', tips)).toEqual({ kind: 'match', id: 'save' });
    expect(matchKeyTip('x', tips)).toEqual({ kind: 'none' });
  });
});
