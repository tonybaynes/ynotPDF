/** Main-owned policy for opening embedded files. Filename cleanup is not type approval. */
import { extname } from 'node:path';
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.csv',
  '.rtf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.webp',
]);
function hasControlCharacter(name: string): boolean {
  for (const ch of name) if ((ch.codePointAt(0) ?? 0) < 32) return true;
  return false;
}
export function assertExternalDocument(name: string): void {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 1024 ||
    /[\\/]/.test(name) ||
    hasControlCharacter(name) ||
    !DOCUMENT_EXTENSIONS.has(extname(name).toLowerCase())
  ) {
    throw new Error(
      'This attachment type cannot be opened directly. Extract it to a folder to inspect it first.',
    );
  }
}
export function externalWebUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only HTTP and HTTPS links may be opened');
  return url.href;
}
