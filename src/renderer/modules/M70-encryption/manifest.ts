/**
 * M70 manifest — encryption, permissions and certificate security.
 *
 * Everything the reader can reach: the Protect ribbon tab that Foxit puts these commands on, the
 * Protect / Remove Security / Unlock / Security Properties commands, a status item that says in a
 * word whether the document is protected, and the permission-aware `when` clauses that other
 * modules' commands consult.
 *
 * The service does the work; this file is what the shell needs to know about it.
 */

import { SERVICE, type ShellServices } from '@app/services';
import { el } from '@app/dom';
import { icon, registerIcon } from '@app/icons';
import { FilePlus, KeyRound, ShieldCheck, ShieldOff, Unlock } from 'lucide';
import type { UiStore } from '@app/ui/UiState';
import type { Document } from '@core/Document';
import { PERMISSION_GATE, type PermissionGate, type Registry } from '@core/Registry';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import { defineModule, type ServiceContext } from '@shared/module';
import { describeIntent } from './intent';
import { SecurityService, SECURITY_SERVICE } from './SecurityService';
import { SECURITY_SETTINGS_SCHEMA } from './settings';

export { SecurityService, SECURITY_SERVICE } from './SecurityService';
export type { DocumentSecurity } from './SecurityService';
export { securityPropertiesPanel } from './dialogs';

/**
 * Icons the shell does not already carry. Registered as this file loads rather than in
 * `activate`, because the ribbon is built from the manifest before any module is activated and an
 * icon registered later would already have been drawn as a placeholder (M21 does the same).
 */
registerIcon('shield-check', ShieldCheck);
registerIcon('shield-off', ShieldOff);
registerIcon('key-round', KeyRound);
registerIcon('unlock', Unlock);
registerIcon('file-plus', FilePlus);

const security = (ctx: ServiceContext): SecurityService =>
  ctx.service<SecurityService>(SECURITY_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(SECURITY_SERVICE);

const hasDocument = (ctx: ServiceContext): boolean =>
  hasService(ctx) && ctx.service<DocumentService>(DOCUMENT_SERVICE).active !== null;

/** True when the active document is protected, or has been asked to be. */
const isProtected = (ctx: ServiceContext): boolean => {
  if (!hasDocument(ctx)) return false;
  const doc = ctx.service<DocumentService>(DOCUMENT_SERVICE).active;
  if (!doc) return false;
  const state = security(ctx).securityOf(doc);
  return state.info.encrypted || state.intent.kind !== 'none';
};

/** True when the document is protected *and* the reader has not unlocked it. */
const isLocked = (ctx: ServiceContext): boolean => {
  if (!hasDocument(ctx)) return false;
  const doc = ctx.service<DocumentService>(DOCUMENT_SERVICE).active;
  if (!doc) return false;
  const state = security(ctx).securityOf(doc);
  return state.info.encrypted && !state.unlocked;
};

function activeDocument(ctx: ServiceContext): Document {
  const doc = ctx.service<DocumentService>(DOCUMENT_SERVICE).active;
  if (!doc) throw new Error('No document is open');
  return doc;
}

/** "Protect" or "Change Protection" — the ribbon says what the button would do. */
function protectLabel(ctx: ServiceContext): string {
  return isProtected(ctx) ? 'Change Protection…' : 'Protect…';
}

export default defineModule({
  id: 'M70',
  name: 'Encryption',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(SECURITY_SERVICE)) return undefined;
    if (!registry.hasService('shellServices') || !registry.hasService(DOCUMENT_SERVICE)) {
      return undefined;
    }
    const shell = registry.service<ShellServices>('shellServices');
    const service = new SecurityService({ registry, shell });
    registry.provide(SECURITY_SERVICE, service);
    // The gate every permission-governed command consults (ADR 0012). Registering it is what
    // turns `CommandSpec.permission` from a declaration into a disabled button with a reason;
    // a build without M70 registers nothing and every command stays enabled.
    registry.provide(PERMISSION_GATE, {
      allows: (permission) => service.allows(permission),
      reasonAgainst: (permission) => service.reasonAgainst(permission),
    } satisfies PermissionGate);
    service.load();
    return () => {
      service.dispose();
    };
  },

  settings: SECURITY_SETTINGS_SCHEMA,

  commands: [
    {
      id: 'protect.security',
      label: 'Protect…',
      category: 'Protect',
      icon: 'lock',
      shortcut: 'Mod+Shift+E',
      description: 'Set an open password, a permissions password or certificate recipients',
      // A reader who opened the document with the *user* password may not change what it
      // allows — that is what the owner password is for, and what `/P` bit 4 says.
      permission: 'modify',
      when: hasDocument,
      run: (ctx) => security(ctx).protect(activeDocument(ctx)),
    },
    {
      id: 'protect.remove',
      label: 'Remove Security',
      category: 'Protect',
      icon: 'shield-off',
      description: 'Take the password or certificate protection off the document',
      permission: 'modify',
      when: isProtected,
      run: (ctx) => security(ctx).removeSecurity(activeDocument(ctx)),
    },
    {
      id: 'protect.unlock',
      label: 'Unlock with Password…',
      category: 'Protect',
      icon: 'unlock',
      description: 'Enter the owner password to lift the restrictions for this session',
      when: isLocked,
      run: (ctx) => security(ctx).unlock(activeDocument(ctx)),
    },
    {
      id: 'protect.properties',
      label: 'Security Properties…',
      category: 'Protect',
      icon: 'shield-check',
      description: 'What protects this document, and what it allows',
      when: hasDocument,
      run: (ctx) => {
        security(ctx).showProperties(activeDocument(ctx));
      },
    },

    // ---- developer commands: how the e2e suite drives protection ---------------------------------
    {
      id: 'dev.securityState',
      label: 'Security: report the state',
      category: 'Developer',
      icon: 'shield-check',
      description: 'What the file says, what the document intends, and what the reader may do',
      when: hasDocument,
      run: (ctx) => {
        const doc = activeDocument(ctx);
        const service = security(ctx);
        const state = service.securityOf(doc);
        return {
          documentId: doc.id,
          title: doc.state.title,
          encrypted: state.info.encrypted,
          handler: state.info.handler,
          algorithm: state.info.algorithm,
          revision: state.info.revision,
          opensWithoutPassword: state.info.opensWithoutPassword,
          metadataEncrypted: state.info.metadataEncrypted,
          permissions: state.info.permissions,
          recipients: state.info.recipients.length,
          unlocked: state.unlocked,
          openedAs: state.openedAs,
          intent: state.intent,
          intentWords: describeIntent(state.intent),
          allows: {
            print: service.allows('print', doc),
            printHigh: service.allows('print-high', doc),
            copy: service.allows('copy', doc),
            modify: service.allows('modify', doc),
            annotate: service.allows('annotate', doc),
            assemble: service.allows('assemble', doc),
          },
          reasonAgainstPrint: service.reasonAgainst('print', doc),
        };
      },
    },
    {
      id: 'dev.setSecurity',
      label: 'Security: set the intent without the dialog',
      category: 'Developer',
      icon: 'key-round',
      description:
        'Applies a SetSecurityCommand from { intent, user, owner } — the e2e suite uses this',
      when: hasDocument,
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const service = security(ctx);
        return service.applyIntentDirectly(doc, ctx.args);
      },
    },
    {
      id: 'dev.unlock',
      label: 'Security: unlock with a password, without the dialog',
      category: 'Developer',
      icon: 'unlock',
      description:
        'Verifies the owner password and lifts the restrictions — the e2e suite uses this',
      when: hasDocument,
      run: (ctx) => {
        const password = ctx.args['password'];
        if (typeof password !== 'string') throw new Error('dev.unlock needs { password }');
        return security(ctx).unlockWithPassword(activeDocument(ctx), password);
      },
    },
    {
      id: 'dev.openWithDigitalId',
      label: 'Security: open a certificate-protected file with a digital ID',
      category: 'Developer',
      icon: 'key-round',
      description:
        'Skips the two native file dialogs only — the unlock and the open are the real ones',
      when: hasService,
      run: (ctx) => {
        const path = ctx.args['path'];
        const p12 = ctx.args['p12'];
        const password = ctx.args['password'];
        if (typeof path !== 'string' || typeof p12 !== 'string' || typeof password !== 'string') {
          throw new Error('dev.openWithDigitalId needs { path, p12, password }');
        }
        return security(ctx).openWithDigitalIdAt(path, p12, password);
      },
    },
    {
      id: 'dev.qpdfVersion',
      label: 'Security: report the qpdf version',
      category: 'Developer',
      icon: 'shield-check',
      description: 'Which qpdf this build ships (ADR 0011)',
      when: hasService,
      run: (ctx) => security(ctx).engineVersion(),
    },
  ],

  ribbon: [
    {
      id: 'protect.security',
      tab: 'protect',
      label: 'Protect',
      order: 10,
      large: ['protect.security'],
      items: [
        { kind: 'button', command: 'protect.security', size: 'large', dynamicLabel: protectLabel },
        { kind: 'button', command: 'protect.remove', size: 'small' },
        { kind: 'button', command: 'protect.unlock', size: 'small' },
        { kind: 'button', command: 'protect.properties', size: 'small' },
      ],
    },
  ],

  statusBar: [
    {
      id: 'security.status',
      slot: 'right',
      order: 4,
      mount: (host, ctx) => mountSecurityStatus(host, ctx),
    },
  ],

  contextMenus: [
    {
      id: 'security.tabMenu',
      region: 'tab',
      order: 20,
      items: [{ command: 'protect.security' }, { command: 'protect.properties' }],
    },
  ],
});

/**
 * The status-bar item: "Protected", "Restricted", "Unlocked" or nothing at all — a word and an
 * icon, with colour only as a third, redundant cue.
 *
 * It is hidden entirely for an unprotected document rather than saying "Not protected", because a
 * permanent label saying nothing happened is noise in a status bar the reader glances at.
 */
function mountSecurityStatus(host: HTMLElement, ctx: ServiceContext): () => void {
  const registry = ctx.service<Registry>('registry');
  const item = el('span.status-security', { 'aria-live': 'polite' });
  const glyph = el('span.status-security-icon', { 'aria-hidden': 'true' });
  const word = el('span.status-security-word');
  item.append(glyph, word);
  host.append(item);

  const render = (): void => {
    if (!registry.hasService(SECURITY_SERVICE) || !registry.hasService(DOCUMENT_SERVICE)) {
      item.hidden = true;
      return;
    }
    const service = registry.service<SecurityService>(SECURITY_SERVICE);
    const doc = registry.service<DocumentService>(DOCUMENT_SERVICE).active;
    if (!doc) {
      item.hidden = true;
      return;
    }
    const state = service.securityOf(doc);
    if (!state.info.encrypted && state.intent.kind === 'none') {
      item.hidden = true;
      return;
    }
    item.hidden = false;
    const [name, text, title] = !state.info.encrypted
      ? ([
          'key-round',
          'Protection pending',
          `${describeIntent(state.intent)}. Save to apply it.`,
        ] as const)
      : state.unlocked
        ? ([
            'unlock',
            'Unlocked',
            state.openedAs
              ? `Opened with ${state.openedAs}. Full permissions for this session.`
              : 'Opened with the owner password. Full permissions for this session.',
          ] as const)
        : ([
            'lock',
            'Restricted',
            service.reasonAgainst('modify', doc) || 'The document is protected.',
          ] as const);
    glyph.replaceChildren(icon(name));
    word.textContent = text;
    item.title = title;
    item.dataset['state'] = text;
  };

  render();
  const stop = ctx.service<UiStore>(SERVICE.ui).subscribe(render);
  return () => {
    stop();
    item.remove();
  };
}
