/** Runtime checks for filesystem and external-action IPC (ADR 0025). */
import { isAbsolute } from 'node:path';
import type { IpcInvokeChannel } from '../../shared/ipc';
function text(value: unknown, max = 32768): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new Error('Invalid text argument');
}
function path(value: unknown): void {
  text(value);
  if (!isAbsolute(value)) throw new Error('An absolute file path is required');
}
function bytes(value: unknown): void {
  if (!(value instanceof Uint8Array)) throw new Error('File data must be bytes');
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid options');
}
function flag(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') throw new Error('Invalid boolean option');
}
function number(value: unknown, min: number, max: number): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
  )
    throw new Error('Invalid numeric option');
}
function dialogOptions(value: unknown): void {
  if (value === undefined) return;
  object(value);
  for (const key of ['title', 'buttonLabel', 'defaultPath'])
    if (value[key] !== undefined) text(value[key]);
  flag(value['multi']);
  flag(value['multiple']);
  if (value['filters'] !== undefined) {
    if (!Array.isArray(value['filters']) || value['filters'].length > 50)
      throw new Error('Invalid file filters');
    for (const f of value['filters']) {
      object(f);
      text(f['name'], 200);
      if (!Array.isArray(f['extensions']) || f['extensions'].length > 100)
        throw new Error('Invalid extensions');
      for (const ext of f['extensions']) text(ext, 64);
    }
  }
}
const PATH_FIRST = new Set<IpcInvokeChannel>([
  'file:read',
  'file:write',
  'file:writeAtomic',
  'file:probe',
  'file:watch',
  'file:suspendWatch',
  'file:readFolder',
  'file:writeInto',
  'shell:showItemInFolder',
  'recent:add',
  'recent:open',
  'recent:pin',
  'recent:remove',
]);
export function validateFileRequest(channel: IpcInvokeChannel, args: unknown[]): void {
  if (PATH_FIRST.has(channel)) path(args[0]);
  if (channel === 'window:new' && args[0] !== undefined) path(args[0]);
  switch (channel) {
    case 'file:write':
      bytes(args[1]);
      break;
    case 'file:writeAtomic':
      bytes(args[1]);
      if (args[2] !== undefined) {
        object(args[2]);
        flag(args[2]['backup']);
      }
      break;
    case 'file:writeInto':
      text(args[1]);
      bytes(args[2]);
      break;
    case 'file:watch':
    case 'recent:pin':
      if (typeof args[1] !== 'boolean') throw new Error('A boolean is required');
      break;
    case 'file:suspendWatch':
      number(args[1], 0, 60000);
      break;
    case 'file:readFolder':
      if (args[1] !== undefined) {
        object(args[1]);
        flag(args[1]['recursive']);
        number(args[1]['limit'], 1, 5000);
      }
      break;
    case 'file:saveDialog':
      if (args[0] !== undefined) text(args[0]);
      break;
    case 'file:saveAsDialog':
    case 'file:openFilesDialog':
      dialogOptions(args[0]);
      break;
    case 'file:pickFile':
      if (!['pdf', 'certificate', 'digital-id'].includes(String(args[0])))
        throw new Error('Invalid file kind');
      dialogOptions(args[1]);
      break;
    case 'dialog:pickFolder':
      if (args[0] !== undefined) text(args[0], 2000);
      break;
    case 'shell:openTempFile':
      text(args[0], 1024);
      bytes(args[1]);
      break;
    case 'shell:openExternal':
      text(args[0], 16384);
      break;
    case 'search:folder': {
      const request = args[0];
      object(request);
      path(request['root']);
      text(request['query'], 4096);
      if (!request['query']) throw new Error('A search query is required');
      if (typeof request['recursive'] !== 'boolean') throw new Error('A boolean is required');
      if (request['maxHits'] === undefined) throw new Error('A search limit is required');
      number(request['maxHits'], 1, 100000);
      const options = request['options'];
      object(options);
      if (options['proximity'] === undefined) throw new Error('A proximity value is required');
      number(options['proximity'], 0, 10000);
      for (const key of [
        'matchCase',
        'wholeWord',
        'regex',
        'ignoreDiacritics',
        'includeBookmarks',
        'includeComments',
        'includeFormFields',
      ])
        if (typeof options[key] !== 'boolean') throw new Error('A boolean is required');
      break;
    }
    case 'recovery:putBlob':
      text(args[0], 128);
      bytes(args[1]);
      break;
    case 'recovery:save':
      text(args[0], 128);
      text(args[1], 64 * 1024 * 1024);
      break;
    case 'recovery:readBlob':
      text(args[0], 128);
      text(args[1], 64);
      break;
    case 'recovery:read':
    case 'recovery:discard':
      text(args[0], 128);
      break;
  }
}
