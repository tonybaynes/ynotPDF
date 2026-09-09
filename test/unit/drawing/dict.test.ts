/**
 * The dictionary entries M31 added to the closed list (ADR 0015): a line's two endings as names,
 * a cloud and a dash as dictionaries, the attached file as a reference — and what "off" means.
 */

import { describe, expect, it } from 'vitest';
import { dictEntries, dictMapping, toDictValue } from '@engine/appearance';
import { must } from '../find/helpers';

describe('the shape family’s entries', () => {
  it('writes /LE as two names, and skips anything else', () => {
    expect(dictEntries({ lineEndings: ['None', 'OpenArrow'] })['LE']).toEqual({
      kind: 'names',
      value: ['None', 'OpenArrow'],
    });
    expect(dictEntries({ lineEndings: ['OpenArrow'] })['LE']).toBeUndefined();
    expect(dictEntries({ lineEndings: ['OpenArrow', 3] })['LE']).toBeUndefined();
    // A callout's single ending is a name, and a line's array wins when both are somehow present.
    expect(dictEntries({ lineEnding: 'OpenArrow' })['LE']).toEqual({
      kind: 'name',
      value: 'OpenArrow',
    });
    expect(
      dictEntries({ lineEnding: 'OpenArrow', lineEndings: ['None', 'Circle'] })['LE']?.kind,
    ).toBe('names');
  });

  it('writes /BE as a dictionary, and removes it when the cloud is turned off', () => {
    expect(dictEntries({ cloudy: 1.5 })['BE']).toEqual({
      kind: 'dict',
      value: { S: { kind: 'name', value: 'C' }, I: { kind: 'number', value: 1.5 } },
    });
    expect(dictEntries({ cloudy: 0 })['BE']).toBeNull();
    expect(dictEntries({ cloudy: null })['BE']).toBeNull();
  });

  it('writes a dash into /BS beside the width, and a solid border when it goes', () => {
    expect(dictEntries({ dashArray: [3, 2] })['BS']).toEqual({
      kind: 'dict',
      value: { S: { kind: 'name', value: 'D' }, D: { kind: 'numbers', value: [3, 2] } },
    });
    // Empty, absent or all-zero dashes are a solid border with its `/D` gone — never a removed `/BS`.
    for (const value of [[], null, [0, 0]]) {
      expect(dictEntries({ dashArray: value })['BS']).toEqual({
        kind: 'dict',
        value: { S: { kind: 'name', value: 'S' }, D: null },
      });
    }
  });

  it('writes /FS as a reference by file name', () => {
    expect(dictEntries({ attachmentName: 'notes.txt' })['FS']).toEqual({
      kind: 'embeddedFile',
      value: 'notes.txt',
    });
    expect(dictEntries({ attachmentName: '' })['FS']).toBeNull();
  });

  it('none of the new entries is one the engine can write', () => {
    for (const key of ['lineEndings', 'cloudy', 'dashArray', 'attachmentName']) {
      expect(must(dictMapping(key), key).engineWritable).toBe(false);
    }
  });

  it('coerces by kind for the plain kinds and refuses a dictionary without an encoder', () => {
    expect(
      toDictValue({ key: 'x', pdfKey: 'X', kind: 'names', engineWritable: false }, ['A', 'B']),
    ).toEqual({ kind: 'names', value: ['A', 'B'] });
    expect(
      toDictValue({ key: 'x', pdfKey: 'X', kind: 'names', engineWritable: false }, ['A', 1]),
    ).toBeNull();
    expect(
      toDictValue({ key: 'x', pdfKey: 'X', kind: 'dict', engineWritable: false }, {}),
    ).toBeNull();
    expect(
      toDictValue({ key: 'x', pdfKey: 'X', kind: 'embeddedFile', engineWritable: false }, 'f'),
    ).toEqual({ kind: 'embeddedFile', value: 'f' });
  });
});
