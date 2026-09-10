/**
 * Who makes this app and where to find it — in one place, so a name, a company or a website can
 * change in a single edit rather than being hunted through dialogs, installers and help pages
 * (the house rule: anything that can change is data, never a literal repeated in code).
 *
 * Read by the About dialog, and by M131's installers, help and first-run screens.
 */

/** The product, as it is written everywhere the reader sees it. */
export const PRODUCT_NAME = 'ynotPDF';

/** The company that makes it. */
export const COMPANY_NAME = 'Ynot Apps';

/** The website, shown to the reader without a scheme. */
export const WEBSITE = 'ynot-apps.com';

/** The website as a link. `https` only — the About dialog will not open anything else. */
export const WEBSITE_URL = 'https://ynot-apps.com';

/** The copyright line, with the year the build was made. */
export function copyrightLine(year: number = new Date().getFullYear()): string {
  return `© ${year} ${COMPANY_NAME}`;
}
