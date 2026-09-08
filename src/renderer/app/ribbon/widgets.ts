/**
 * Ribbon widgets (M02): one renderer per `RibbonItemSpec` kind. Each returns a `Widget` whose
 * `update(state)` patches enabled / pressed / value in place, so a group's DOM is built once
 * and only touched when its signature changes. Popups (menus, galleries, colour pickers) are
 * positioned DOM through `popup.ts`.
 */

import { formatShortcut } from '@core/Registry';
import type { MenuItemSpec, RibbonMenu, RibbonOptionSpec } from '@shared/module';
import { button, el, srOnly } from '../dom';
import { icon } from '../icons';
import { openMenu } from '../menu';
import { openPopup, type PopupHandle } from '../popup';
import type { ShellServices } from '../services';
import type { ItemState, RibbonItemModel } from './model';

/** A menu may be a function so its items reflect the moment it opens (recent files). */
const resolveMenu = (menu: RibbonMenu): ReadonlyArray<MenuItemSpec> =>
  typeof menu === 'function' ? menu() : menu;

export interface Widget {
  readonly element: HTMLElement;
  /** The element that takes focus / carries the key tip. */
  readonly focusTarget: HTMLElement;
  update(state: ItemState): void;
}

/** Tooltip text: label plus the shortcut, if any. */
export function commandTitle(
  services: ShellServices,
  commandId: string | undefined,
  label: string,
): string {
  const key = commandId ? services.registry.shortcutFor(commandId) : undefined;
  const desc = commandId ? services.registry.get(commandId)?.description : undefined;
  const parts = [label];
  if (key) parts[0] = `${label} (${formatShortcut(key, services.isMac)})`;
  if (desc) parts.push(desc);
  // A control the document's security has disabled says which permission is missing and what
  // would lift it (M70). A disabled control with no explanation is the thing this app avoids.
  const blocked = commandId ? services.registry.reasonDisabled(commandId) : '';
  if (blocked !== '') parts.push(blocked);
  return parts.join('\n');
}

function labelNode(item: RibbonItemModel, size: 'large' | 'small'): HTMLElement {
  const span = el('span.rb-label', null, item.label);
  if (size === 'large') span.classList.add('rb-label-large');
  return span;
}

function baseButton(item: RibbonItemModel, services: ShellServices, extra = ''): HTMLButtonElement {
  const size = item.size;
  const b = button(`rb-btn rb-${size}${extra ? ` ${extra}` : ''}`, {
    'data-item': item.id,
    'data-command': item.command,
    title:
      item.spec?.kind === 'button' && item.spec.title
        ? item.spec.title
        : commandTitle(services, item.command, item.label),
  });
  b.append(icon(item.icon, { size: size === 'large' ? 'lg' : 'sm', fallbackText: item.label }));
  b.append(labelNode(item, size));
  return b;
}

function chevron(): SVGSVGElement {
  const c = icon('chevron-down');
  c.classList.add('rb-chevron');
  return c;
}

function runCommand(
  services: ShellServices,
  item: RibbonItemModel,
  args?: Readonly<Record<string, unknown>>,
): void {
  if (!item.command) return;
  void services.run(item.command, args);
}

// ---- button / toggle ---------------------------------------------------------------------------

/**
 * Applies a `dynamicLabel` result (M20, ADR 0008) to the visible text and the tooltip. The label
 * span is the button's content, so the accessible name follows it: a screen reader announces the
 * same "Undo Rotate page" a sighted user reads.
 */
function applyLabel(
  button: HTMLButtonElement,
  item: RibbonItemModel,
  services: ShellServices,
  label: string | null,
): void {
  const span = button.querySelector('.rb-label');
  const text = label ?? item.label;
  if (span && span.textContent !== text) span.textContent = text;
  const title = commandTitle(services, item.command, text);
  if (button.title !== title) button.title = title;
}

function renderButton(item: RibbonItemModel, services: ShellServices): Widget {
  const b = baseButton(item, services);
  b.addEventListener('click', () => {
    runCommand(services, item);
  });
  return {
    element: b,
    focusTarget: b,
    update: (s) => {
      b.disabled = !s.enabled;
      if (s.label !== null) applyLabel(b, item, services, s.label);
    },
  };
}

function renderToggle(item: RibbonItemModel, services: ShellServices): Widget {
  const b = baseButton(item, services, 'rb-toggle');
  const state = srOnly('');
  b.append(state);
  b.addEventListener('click', () => {
    runCommand(services, item);
  });
  return {
    element: b,
    focusTarget: b,
    update: (s) => {
      b.disabled = !s.enabled;
      if (s.label !== null) applyLabel(b, item, services, s.label);
      const on = s.pressed === true;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      state.textContent = on ? ' (on)' : ' (off)';
    },
  };
}

// ---- dropdown / split ------------------------------------------------------------------------

function renderDropdown(item: RibbonItemModel, services: ShellServices): Widget {
  const spec = item.spec;
  const b = baseButton(item, services, 'rb-dropdown');
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.append(chevron());
  const open = (): void => {
    if (spec?.kind !== 'dropdown') return;
    openMenu({
      anchor: b,
      items: resolveMenu(spec.menu),
      registry: services.registry,
      isMac: services.isMac,
      label: item.label,
    });
  };
  b.addEventListener('click', open);
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
  return {
    element: b,
    focusTarget: b,
    update: (s) => {
      b.disabled = !s.enabled;
    },
  };
}

function renderSplit(item: RibbonItemModel, services: ShellServices): Widget {
  const spec = item.spec;
  const wrap = el('div.rb-split', { 'data-item': item.id });
  wrap.classList.add(`rb-${item.size}`);
  const main = baseButton(item, services, 'rb-split-main');
  main.addEventListener('click', () => {
    runCommand(services, item);
  });
  const arrow = button('rb-btn rb-split-arrow', {
    'aria-label': `More options for ${item.label}`,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    title: `More options for ${item.label}`,
  });
  arrow.append(chevron());
  const open = (): void => {
    if (spec?.kind !== 'split') return;
    openMenu({
      anchor: arrow,
      items: resolveMenu(spec.menu),
      registry: services.registry,
      isMac: services.isMac,
      label: item.label,
    });
  };
  arrow.addEventListener('click', open);
  arrow.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
  wrap.append(main, arrow);
  return {
    element: wrap,
    focusTarget: main,
    update: (s) => {
      main.disabled = !s.enabled;
    },
  };
}

// ---- gallery -----------------------------------------------------------------------------------

function optionGrid(
  options: ReadonlyArray<RibbonOptionSpec>,
  selected: string | null,
  label: string,
  onPick: (value: string) => void,
  renderOption?: (o: RibbonOptionSpec) => Node,
): HTMLElement {
  const grid = el('div.gallery', { role: 'listbox', 'aria-label': label });
  const cells: HTMLButtonElement[] = [];
  options.forEach((o, i) => {
    const cell = button('gallery-cell', {
      role: 'option',
      'aria-selected': o.value === selected ? 'true' : 'false',
      'data-value': o.value,
      title: o.label,
      tabindex: i === 0 ? 0 : -1,
    });
    cell.append(
      renderOption ? renderOption(o) : icon(o.icon, { fallbackText: o.label }),
      el('span.gallery-label', null, o.label),
    );
    if (o.value === selected) cell.append(srOnly(' (selected)'));
    cell.addEventListener('click', () => {
      onPick(o.value);
    });
    cells.push(cell);
    grid.append(cell);
  });
  const focusCell = (i: number): void => {
    const idx = ((i % cells.length) + cells.length) % cells.length;
    cells.forEach((c, k) => {
      c.tabIndex = k === idx ? 0 : -1;
    });
    cells[idx]?.focus();
  };
  grid.addEventListener('keydown', (e) => {
    const cur = cells.findIndex((c) => c === document.activeElement);
    const cols = Math.max(1, Math.round(grid.clientWidth / (cells[0]?.offsetWidth ?? 1)) || 1);
    if (e.key === 'ArrowRight') focusCell(cur + 1);
    else if (e.key === 'ArrowLeft') focusCell(cur - 1);
    else if (e.key === 'ArrowDown') focusCell(cur + cols);
    else if (e.key === 'ArrowUp') focusCell(cur - cols);
    else if (e.key === 'Home') focusCell(0);
    else if (e.key === 'End') focusCell(cells.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      cells[cur]?.click();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const sel = cells.find((c) => c.getAttribute('aria-selected') === 'true');
  if (sel) {
    cells.forEach((c) => {
      c.tabIndex = c === sel ? 0 : -1;
    });
  }
  return grid;
}

function renderGallery(item: RibbonItemModel, services: ShellServices): Widget {
  const spec = item.spec;
  const b = baseButton(item, services, 'rb-gallery');
  b.setAttribute('aria-haspopup', 'listbox');
  b.setAttribute('aria-expanded', 'false');
  b.append(chevron());
  let current: string | null = null;
  let popup: PopupHandle | null = null;
  const open = (): void => {
    if (spec?.kind !== 'gallery') return;
    const grid = optionGrid(spec.options, current, item.label, (value) => {
      popup?.close('select');
      runCommand(services, item, { value });
    });
    popup = openPopup({
      anchor: b,
      content: grid,
      role: 'dialog',
      label: item.label,
      className: 'gallery-popup',
    });
  };
  b.addEventListener('click', open);
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
  const valueLabel = el('span.rb-value');
  b.append(valueLabel);
  return {
    element: b,
    focusTarget: b,
    update: (s) => {
      b.disabled = !s.enabled;
      current = s.value;
      const opt =
        spec?.kind === 'gallery' ? spec.options.find((o) => o.value === s.value) : undefined;
      valueLabel.textContent = opt ? opt.label : '';
      valueLabel.hidden = !opt;
    },
  };
}

// ---- colour picker -----------------------------------------------------------------------------

function renderColor(item: RibbonItemModel, services: ShellServices): Widget {
  const spec = item.spec;
  const b = baseButton(item, services, 'rb-color');
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-expanded', 'false');
  const swatch = el('span.rb-swatch', { 'aria-hidden': 'true' });
  b.insertBefore(swatch, b.firstChild);
  const valueText = srOnly('');
  b.append(valueText, chevron());
  let current = '';
  let popup: PopupHandle | null = null;
  const open = (): void => {
    if (spec?.kind !== 'color') return;
    const content = el('div.color-picker');
    const pick = (value: string): void => {
      popup?.close('select');
      runCommand(services, item, { value });
    };
    if (spec.swatches?.length) {
      content.append(
        optionGrid(spec.swatches, current, `${item.label} swatches`, pick, (o) => {
          const s = el('span.color-cell', { 'aria-hidden': 'true' });
          s.style.background = o.value;
          return s;
        }),
      );
    }
    const custom = el('div.color-custom');
    const input = el('input', { type: 'color', 'aria-label': `Custom ${item.label}` });
    if (/^#[0-9a-f]{6}$/i.test(current)) input.value = current;
    const apply = button('btn btn-small', null, 'Apply custom colour');
    apply.addEventListener('click', () => {
      pick(input.value);
    });
    custom.append(input, apply);
    content.append(custom);
    popup = openPopup({
      anchor: b,
      content,
      role: 'dialog',
      label: item.label,
      className: 'color-popup',
    });
  };
  b.addEventListener('click', open);
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
  return {
    element: b,
    focusTarget: b,
    update: (s) => {
      b.disabled = !s.enabled;
      current = s.value ?? '';
      swatch.style.background = current;
      const named =
        spec?.kind === 'color' ? spec.swatches?.find((o) => o.value === current)?.label : undefined;
      valueText.textContent = current ? ` current: ${named ?? current}` : '';
    },
  };
}

// ---- input -------------------------------------------------------------------------------------

function renderInput(item: RibbonItemModel, services: ShellServices): Widget {
  const spec = item.spec;
  const wrap = el('label.rb-input', { 'data-item': item.id });
  wrap.append(el('span.rb-input-label', null, item.label));
  let control: HTMLInputElement | HTMLSelectElement;
  if (spec?.kind === 'input' && spec.type === 'select') {
    const select = el('select');
    for (const o of spec.options ?? []) select.append(el('option', { value: o.value }, o.label));
    control = select;
  } else {
    const input = el('input', {
      type: spec?.kind === 'input' && spec.type === 'number' ? 'number' : 'text',
    });
    if (spec?.kind === 'input') {
      if (spec.min !== undefined) input.min = String(spec.min);
      if (spec.max !== undefined) input.max = String(spec.max);
      if (spec.step !== undefined) input.step = String(spec.step);
      if (spec.width) input.style.width = `calc(${spec.width}ch + 1.4rem)`;
    }
    control = input;
  }
  control.title = commandTitle(services, item.command, item.label);
  wrap.append(control);
  let last = '';
  const commit = (): void => {
    if (control.value === last) return;
    last = control.value;
    runCommand(services, item, { value: control.value });
  };
  control.addEventListener('change', commit);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      control.value = last;
    }
  };
  (control as HTMLElement).addEventListener('keydown', onKey);
  return {
    element: wrap,
    focusTarget: control,
    update: (s) => {
      control.disabled = !s.enabled;
      if (document.activeElement !== control) {
        last = s.value ?? '';
        control.value = last;
      }
    },
  };
}

/** Renders one normalised item. Separators return a plain `<span role="separator">`. */
export function renderItem(item: RibbonItemModel, services: ShellServices): Widget {
  switch (item.kind) {
    case 'separator': {
      const sep = el('span.rb-separator', { role: 'separator', 'aria-orientation': 'vertical' });
      return { element: sep, focusTarget: sep, update: () => undefined };
    }
    case 'toggle':
      return renderToggle(item, services);
    case 'dropdown':
      return renderDropdown(item, services);
    case 'split':
      return renderSplit(item, services);
    case 'gallery':
      return renderGallery(item, services);
    case 'color':
      return renderColor(item, services);
    case 'input':
      return renderInput(item, services);
    case 'button':
    default:
      return renderButton(item, services);
  }
}
