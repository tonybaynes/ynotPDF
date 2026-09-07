/**
 * Key tips (M02): the letters shown on ribbon tabs and controls after Alt, as in Office/Foxit.
 * Assignment is a pure function so it is deterministic and unit-testable: a control's own
 * `keyTip` wins; otherwise the first letter of its label, then the first two, then a second
 * letter drawn from the rest of the label, then digits — always unique within one level.
 */

export interface KeyTipTarget {
  readonly id: string;
  readonly label: string;
  /** Explicit tip from the spec; honoured unless it collides. */
  readonly keyTip?: string;
}

function letters(label: string): string[] {
  return label
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => word.split(''));
}

/** Candidate tips for one label, best first. */
export function candidates(label: string): string[] {
  const words = label
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  const first = words[0]?.[0];
  if (first) out.push(first);
  // Initials of the first two words ("Save As" → "SA"), then first two letters ("SA" / "SV").
  if (words.length > 1 && words[0]?.[0] && words[1]?.[0]) out.push(words[0][0] + words[1][0]);
  const all = letters(label);
  if (all.length > 1 && all[0]) {
    for (let i = 1; i < all.length; i++) {
      const c = all[0] + (all[i] ?? '');
      if (!out.includes(c)) out.push(c);
    }
  }
  for (const l of all) if (!out.includes(l)) out.push(l);
  return out;
}

/**
 * Assigns a unique tip to each target. Returns a map id → tip. Targets are processed in order,
 * explicit tips first so a module's chosen letter beats a generated one.
 */
export function assignKeyTips(targets: ReadonlyArray<KeyTipTarget>): Map<string, string> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const t of targets) {
    if (!t.keyTip) continue;
    const tip = t.keyTip.toUpperCase();
    if (used.has(tip)) continue;
    used.add(tip);
    result.set(t.id, tip);
  }
  for (const t of targets) {
    if (result.has(t.id)) continue;
    let chosen: string | undefined;
    for (const c of candidates(t.label)) {
      // A one-letter tip must not be the prefix of a two-letter one, or typing is ambiguous.
      if (used.has(c)) continue;
      if (c.length === 1 && Array.from(used).some((u) => u.length === 2 && u.startsWith(c)))
        continue;
      if (c.length === 2 && used.has(c[0] ?? '')) continue;
      chosen = c;
      break;
    }
    if (!chosen) {
      for (let n = 1; n < 100; n++) {
        const c = String(n);
        if (!used.has(c) && !Array.from(used).some((u) => u.startsWith(c) || c.startsWith(u))) {
          chosen = c;
          break;
        }
      }
    }
    chosen ??= `Z${used.size}`;
    used.add(chosen);
    result.set(t.id, chosen);
  }
  return result;
}

/**
 * Resolves what the user has typed so far against the assigned tips: an exact match, a prefix
 * of longer tips (keep waiting), or nothing (invalid).
 */
export function matchKeyTip(
  typed: string,
  tips: ReadonlyMap<string, string>,
): { kind: 'match'; id: string } | { kind: 'partial' } | { kind: 'none' } {
  const t = typed.toUpperCase();
  for (const [id, tip] of tips) if (tip === t) return { kind: 'match', id };
  for (const tip of tips.values()) if (tip.startsWith(t) && tip !== t) return { kind: 'partial' };
  return { kind: 'none' };
}
