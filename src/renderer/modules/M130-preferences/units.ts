/**
 * The app-wide measurement unit (M130).
 *
 * Rulers, crop boxes, page sizes and (later) the measuring tools all have to agree about whether
 * this operator thinks in millimetres or inches, and asking them separately would be four places
 * to get it wrong. `app.units` is that one answer.
 *
 * M11 already owns `viewer.rulers.units` and reads it in its own `load()`. Rather than take the
 * key off it — which would mean editing another module's folder — writing `app.units` writes the
 * ruler key too, so there is one control in Preferences and one value the app obeys. A module
 * built later reads {@link UNITS_SERVICE} instead and needs no mirror.
 */

import type { SettingsSchema } from '@shared/module';
import { UNITS, type Unit } from '@view/units';
import { t } from './i18n';

export const UNITS_KEY = 'app.units';
/** The key M11 reads. Written in step with {@link UNITS_KEY}; see the file comment. */
export const RULER_UNITS_KEY = 'viewer.rulers.units';

export const DEFAULT_UNIT: Unit = 'mm';

export function isUnit(value: unknown): value is Unit {
  return UNITS.some((u) => u.id === value);
}

export function readUnit(value: unknown): Unit {
  return isUnit(value) ? value : DEFAULT_UNIT;
}

/** What a module asks the Registry for when it needs the reader's unit. */
export const UNITS_SERVICE = 'units';

export interface UnitsService {
  /** The unit in force. */
  readonly unit: Unit;
  /** Sets it (and the ruler key with it), persisting and applying. */
  set(unit: Unit): Promise<void>;
  subscribe(listener: (unit: Unit) => void): () => void;
}

/**
 * The unit options, as the enum setting and any picker want them.
 *
 * The labels go through `t()` rather than straight out of `@view/units`: "millimetres" and
 * "centimetres" are spelled differently in American English, which makes these the strings that
 * show the language switch actually doing something.
 */
export const UNIT_LABELS: Readonly<Record<Unit, () => string>> = {
  pt: () => t('units.pt', 'Points'),
  mm: () => t('units.mm', 'Millimetres'),
  cm: () => t('units.cm', 'Centimetres'),
  in: () => t('units.in', 'Inches'),
};

export function unitOptions(): ReadonlyArray<{ readonly value: string; readonly label: string }> {
  return UNITS.map((u) => ({ value: u.id, label: UNIT_LABELS[u.id]() }));
}

/** M130's own settings schema, which is where the app-wide unit is declared. */
export function unitsSetting(): SettingsSchema['properties'] {
  return {
    units: {
      type: 'enum',
      title: t('prefs.units', 'Measurement units'),
      description: t(
        'prefs.unitsHint',
        'Used by the rulers, page sizes, cropping and the measuring tools. Changing it here changes all of them.',
      ),
      default: DEFAULT_UNIT,
      options: unitOptions(),
      keywords: ['units', 'inches', 'millimetres', 'points', 'measure'],
      live: true,
    },
  };
}
