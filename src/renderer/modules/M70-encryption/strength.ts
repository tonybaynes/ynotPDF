/**
 * The password strength meter (M70).
 *
 * Foxit shows a coloured bar. This shows **a word, an icon and a sentence saying why**, because a
 * bar that is green rather than red tells the operator nothing at all — red and black read the
 * same to him — and because "Weak: longer is the single biggest improvement" is more use than any
 * colour to anybody.
 *
 * It never blocks a save. A reader who wants a four-character password on their own document is
 * entitled to one; the meter's job is to say what it is, not to argue.
 *
 * The wording and the thresholds live in `resources/password-rules.json`, not here (CLAUDE.md).
 */

import rules from '../../../../resources/password-rules.json';

export interface StrengthBand {
  readonly score: number;
  readonly word: string;
  readonly icon: string;
}

export interface Strength {
  /** 0–100. Only ever shown through {@link Strength.word}. */
  readonly score: number;
  /** "Very weak" … "Very strong". */
  readonly word: string;
  /** Lucide icon name, so the meter is never a colour on its own. */
  readonly icon: string;
  /** One sentence saying what would improve it, or what is good about it. */
  readonly advice: string;
}

const BANDS: ReadonlyArray<StrengthBand> = rules.bands;
const ADVICE = rules.advice;
const COMMON = new Set(rules.common.map((p) => p.toLowerCase()));

/**
 * Scores a password.
 *
 * Length dominates, which is the honest weighting: a sixteen-character passphrase of lower-case
 * words is harder to guess than eight characters of mixed punctuation, and a meter that says
 * otherwise teaches the wrong lesson. Character variety adds to it, and three specific patterns
 * take away from it — being on the short list of passwords everyone picks, repeating one
 * character, and running up the keyboard.
 */
export function strengthOf(password: string): Strength {
  if (password === '') return band(0, ADVICE.empty);
  if (COMMON.has(password.toLowerCase())) return band(0, ADVICE.common);

  const classes = characterClasses(password);
  // Length: 5 points a character up to 60, so twelve characters alone reach "Fair".
  let score = Math.min(60, password.length * 5);
  // Variety: up to 39 more.
  score += (classes - 1) * 13;

  // Specific problems first, generic ones after. A password that is a keyboard run should be told
  // *that*, not "try adding a digit" — the specific fault is the one the reader can act on, and
  // only the first line of advice is shown.
  const specific: string[] = [];
  const generic: string[] = [];
  if (hasLongRun(password)) {
    score -= 25;
    specific.push(ADVICE.repeated);
  }
  if (hasSequence(password)) {
    score -= 20;
    specific.push(ADVICE.sequence);
  }
  if (password.length < 12) generic.push(ADVICE.short);
  if (classes === 1) generic.push(ADVICE.oneClass);
  else if (classes === 2) generic.push(ADVICE.twoClasses);

  score = Math.max(0, Math.min(100, score));
  return band(score, specific[0] ?? generic[0] ?? ADVICE.good);
}

/** How many of the four character classes appear: lower, upper, digit, everything else. */
function characterClasses(password: string): number {
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  return classes;
}

/** Three or more of the same character in a row, or a password made of one repeated block. */
function hasLongRun(password: string): boolean {
  if (/(.)\1{2,}/.test(password)) return true;
  for (let size = 1; size <= password.length / 2; size++) {
    const unit = password.slice(0, size);
    if (unit.repeat(Math.ceil(password.length / size)).startsWith(password)) {
      return true;
    }
  }
  return false;
}

/** Four or more characters running up or down in code-point order: `abcd`, `4321`. */
function hasSequence(password: string): boolean {
  let up = 1;
  let down = 1;
  for (let i = 1; i < password.length; i++) {
    const step = password.charCodeAt(i) - password.charCodeAt(i - 1);
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    if (up >= 4 || down >= 4) return true;
  }
  return false;
}

function band(score: number, advice: string): Strength {
  let chosen = BANDS[0] ?? { score: 0, word: 'Very weak', icon: 'octagon-x' };
  for (const b of BANDS) if (score >= b.score) chosen = b;
  return { score, word: chosen.word, icon: chosen.icon, advice };
}

/**
 * What is wrong with a pair of passwords, as a sentence, or `null` when nothing is.
 *
 * The two checks a Protect dialog has to make and that no strength meter covers: the confirmation
 * has to match, and using the same value for both passwords means the permissions password
 * protects nothing — anyone who can open the file can also change what it allows.
 */
export function passwordProblem(options: {
  readonly user: string;
  readonly userConfirm: string;
  readonly owner: string;
  readonly ownerConfirm: string;
}): string | null {
  if (options.user !== options.userConfirm) {
    return 'The two open passwords are not the same. Check them and try again.';
  }
  if (options.owner !== options.ownerConfirm) {
    return 'The two permissions passwords are not the same. Check them and try again.';
  }
  if (options.user === '' && options.owner === '') {
    return 'Enter an open password, a permissions password, or both.';
  }
  if (options.user !== '' && options.user === options.owner) {
    return 'The open password and the permissions password are the same, so the permissions password protects nothing. Use a different one, or leave it empty.';
  }
  return null;
}

/**
 * The caution a permissions-only arrangement deserves, or `null`.
 *
 * An empty owner password *is* a valid owner password, so a file with an open password and no
 * permissions password can be opened with full rights by anyone who has the open password. qpdf
 * calls this insecure and will not write it without being told; the reader should hear the same
 * thing in words before it happens, not afterwards.
 */
export function permissionsCaution(user: string, owner: string): string | null {
  if (user !== '' && owner === '') {
    return 'Without a permissions password, anyone who can open the document can also change what it allows. The restrictions below will be a request rather than a rule.';
  }
  if (user === '' && owner !== '') {
    return 'Anyone can open the document; the permissions password is needed only to change what it allows. Most viewers respect that, but not all of them do.';
  }
  return null;
}
