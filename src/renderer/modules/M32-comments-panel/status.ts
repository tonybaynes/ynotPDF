/**
 * Review status (M32). ISO 32000-1 12.5.6.4 defines two state models: `/Review`, whose states are
 * Accepted, Rejected, Cancelled, Completed and None, and `/Marked`, whose two states are the
 * reader's own checkmark. Both are here, and both are told apart by a **word and an icon**.
 *
 * The colours matter less than the words and are chosen so they still separate for a dichromat:
 * Accepted and Rejected would be the classic green/red pair, which the operator cannot use at
 * all, so they differ in glyph (a tick in a ring against a cross in a ring), in word, and in
 * lightness through the theme's own `--success` and `--danger`, which M01 already proved apart on
 * blue↔yellow and lightness. Nothing in the panel is told apart by colour alone.
 */

/** `/StateModel` values. */
export const REVIEW_MODEL = 'Review';
export const MARKED_MODEL = 'Marked';
export const MARKED_ON = 'Marked';
export const MARKED_OFF = 'Unmarked';

export type StatusId = 'none' | 'accepted' | 'rejected' | 'cancelled' | 'completed';

export interface StatusSpec {
  readonly id: StatusId;
  /** The `/State` string written to the file. */
  readonly state: string;
  /** The word shown beside the icon — never an icon on its own. */
  readonly label: string;
  /** Lucide icon name. */
  readonly icon: string;
  /** Theme token for the icon's colour. Always accompanied by {@link label}. */
  readonly token: string;
}

/** The five review states, in the order the menu lists them. */
export const STATUSES: ReadonlyArray<StatusSpec> = [
  {
    id: 'accepted',
    state: 'Accepted',
    label: 'Accepted',
    icon: 'circle-check',
    token: '--success',
  },
  { id: 'rejected', state: 'Rejected', label: 'Rejected', icon: 'circle-x', token: '--danger' },
  {
    id: 'cancelled',
    state: 'Cancelled',
    label: 'Cancelled',
    icon: 'circle-slash',
    token: '--warning',
  },
  {
    id: 'completed',
    state: 'Completed',
    label: 'Completed',
    icon: 'square-check',
    token: '--info',
  },
  { id: 'none', state: 'None', label: 'No status', icon: 'circle-dashed', token: '--fg-muted' },
];

const NO_STATUS: StatusSpec = {
  id: 'none',
  state: 'None',
  label: 'No status',
  icon: 'circle-dashed',
  token: '--fg-muted',
};

const BY_ID = new Map(STATUSES.map((s) => [s.id, s]));
const BY_STATE = new Map(STATUSES.map((s) => [s.state.toLowerCase(), s]));

export function statusSpec(id: StatusId): StatusSpec {
  // The list always ends with "No status", which is the only sensible answer for an unknown id.
  return BY_ID.get(id) ?? NO_STATUS;
}

/**
 * The status an annotation's `/State` names, or null when it names none. A `/Marked` state is not
 * a review status and returns null; the checkmark is read separately.
 */
export function statusOf(state: string | null, model: string): StatusId | null {
  if (state === null || state === '') return null;
  if (model === MARKED_MODEL) return null;
  return BY_STATE.get(state.toLowerCase())?.id ?? null;
}

/** The word for a status, for the summary and for a screen reader. */
export function statusLabel(id: StatusId): string {
  return statusSpec(id).label;
}
