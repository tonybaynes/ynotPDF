/** SPDX grouping is semantic: alternatives use OR, accumulated obligations use AND. */
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
type Expression =
  | { license: string; exception?: string; plus?: boolean }
  | { conjunction: 'and' | 'or'; left: Expression; right: Expression };
const parse = require_('spdx-expression-parse') as (expression: string) => Expression;
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'BlueOak-1.0.0',
  'WTFPL',
  'Zlib',
  'Artistic-2.0',
]);
function allowed(expression: Expression): boolean {
  if ('license' in expression) return !expression.exception && ALLOWED.has(expression.license);
  return expression.conjunction === 'and'
    ? allowed(expression.left) && allowed(expression.right)
    : allowed(expression.left) || allowed(expression.right);
}
export function licenseOk(expression: string | ReadonlyArray<string> | undefined): boolean {
  if (Array.isArray(expression))
    return (
      expression.length > 0 &&
      expression.every((part: unknown) => typeof part === 'string' && licenseOk(part))
    );
  if (typeof expression !== 'string') return false;
  try {
    return allowed(parse(expression));
  } catch {
    return false;
  }
}
export function packageLicenseOk(
  pkg: string,
  license: string | string[] | undefined,
  options: { root: string; privateRoot: boolean; isRootPath: boolean },
): boolean {
  if (license === 'UNLICENSED')
    return pkg === options.root && options.privateRoot && options.isRootPath;
  return licenseOk(license);
}
