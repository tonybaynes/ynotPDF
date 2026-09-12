import { describe, expect, it } from 'vitest';
import { licenseOk, packageLicenseOk } from '../../../scripts/lib/license-policy';
describe('licence expression policy', () => {
  it.each(['MIT', '(MIT OR Apache-2.0) AND Zlib', 'MIT OR GPL-3.0', 'GPL-3.0 OR (ISC AND MIT)'])(
    'accepts a permitted option in %s',
    (expr) => {
      expect(licenseOk(expr)).toBe(true);
    },
  );
  it.each([
    '(MIT OR Apache-2.0) AND GPL-3.0',
    'MIT AND (ISC OR GPL-3.0) AND AGPL-3.0',
    'MPL-2.0',
    'UNLICENSED',
    'UNKNOWN',
    'MIT OR',
    'MIT WITH Classpath-exception-2.0',
  ])('refuses %s', (expr) => {
    expect(licenseOk(expr)).toBe(false);
  });
  it('treats a licence array as accumulated obligations', () => {
    expect(licenseOk(['MIT', 'GPL-3.0'])).toBe(false);
    expect(licenseOk(['MIT', 'ISC'])).toBe(true);
    expect(licenseOk([])).toBe(false);
  });
  it('limits the unlicensed exception to the actual private root', () => {
    const options = { root: 'ynotpdf@0.0.1', privateRoot: true, isRootPath: true };
    expect(packageLicenseOk(options.root, 'UNLICENSED', options)).toBe(true);
    expect(packageLicenseOk('dependency@1', 'UNLICENSED', options)).toBe(false);
    expect(packageLicenseOk(options.root, 'UNLICENSED', { ...options, isRootPath: false })).toBe(
      false,
    );
    expect(packageLicenseOk(options.root, 'UNLICENSED', { ...options, privateRoot: false })).toBe(
      false,
    );
  });
});
