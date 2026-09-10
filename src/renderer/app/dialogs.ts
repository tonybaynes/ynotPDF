/**
 * Minimal dialogs for M00: About and a generic message box. Both are native `<dialog>`
 * elements (fully opaque, keyboard-reachable, Escape closes). M02 grows this into the dialog
 * service.
 */

import { hasBridge, invoke, type AppInfo } from '@shared/ipc';
import { platformLabel } from '@shared/platform';
import { COMPANY_NAME, PRODUCT_NAME, WEBSITE, WEBSITE_URL, copyrightLine } from '@shared/brand';

/** Opens the About dialog and resolves when it closes. */
export function showAbout(info: AppInfo | null): HTMLDialogElement {
  const existing = document.getElementById('about-dialog');
  if (existing instanceof HTMLDialogElement) {
    if (!existing.open) existing.showModal();
    return existing;
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'about-dialog';
  dialog.setAttribute('aria-labelledby', 'about-title');

  const h2 = document.createElement('h2');
  h2.id = 'about-title';
  h2.textContent = `About ${PRODUCT_NAME}`;

  const p = document.createElement('p');
  p.textContent = 'Cross-platform PDF editor. Electron + TypeScript + PDFium.';

  const dl = document.createElement('dl');
  const rows: [string, string][] = info
    ? [
        ['Version', info.version],
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node', info.node],
        // M03: named in words, and says so when an x64 build is running emulated on ARM.
        ['Platform', platformLabel(info.platform, info.arch, info.hostArch)],
      ]
    : [['Version', 'development']];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dd.dataset['field'] = k.toLowerCase();
    dl.append(dt, dd);
  }

  // Who makes it and where to find them. The website is a button, not an <a>: the renderer
  // never navigates itself — the main process opens the reader's own browser.
  const maker = document.createElement('p');
  maker.className = 'about-maker';
  maker.append(document.createTextNode(`Made by ${COMPANY_NAME} — `));
  const site = document.createElement('button');
  site.type = 'button';
  site.className = 'btn btn-link';
  site.id = 'about-website';
  site.textContent = WEBSITE;
  site.title = `Open ${WEBSITE_URL} in your browser`;
  site.addEventListener('click', () => {
    if (hasBridge()) void invoke('shell:openExternal', WEBSITE_URL);
  });
  maker.append(site);

  const copyright = document.createElement('p');
  copyright.className = 'about-copyright';
  copyright.id = 'about-copyright';
  copyright.textContent = copyrightLine();

  const actions = document.createElement('div');
  actions.className = 'actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-primary';
  close.textContent = 'Close';
  close.addEventListener('click', () => {
    dialog.close();
  });
  actions.append(close);

  dialog.append(h2, p, dl, maker, copyright, actions);
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  return dialog;
}

/** Simple message box (title + text + OK). Resolves when dismissed. */
export function showMessage(title: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'message';
    const h2 = document.createElement('h2');
    h2.textContent = title;
    const p = document.createElement('p');
    p.textContent = text;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = 'OK';
    ok.addEventListener('click', () => {
      dialog.close();
    });
    actions.append(ok);
    dialog.append(h2, p, actions);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}
