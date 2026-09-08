/**
 * Markdown → HTML (M91): GFM rendering of the notes fixture, the document wrapper, escaping
 * and the `file:` URL helpers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  escapeAttribute,
  escapeText,
  fileUrl,
  folderUrl,
  markdownToHtml,
  renderMarkdown,
} from '@engine/create/markdown';
import { FIXTURES } from '../engine/helpers';

const notes = readFileSync(join(FIXTURES, 'create', 'notes.md'), 'utf8');

describe('renderMarkdown', () => {
  it('renders every GFM construct in the notes fixture', () => {
    const html = renderMarkdown(notes);
    expect(html).toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>inline code</code>');
    expect(html).toContain('href="https://example.com/notes"');
    expect(html).toContain('<ol');
    expect(html).toContain('<ul');
    expect(html).toContain('<blockquote');
    expect(html).toContain('<pre');
    expect(html).toContain('language-ts');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('Apple');
    expect(html).toContain('<hr');
    expect(html).toContain('<img');
    expect(html).toContain('src="logo-alpha.png"');
    expect(html).toContain('type="checkbox"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('checked');
  });

  it('renders nothing for nothing', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('markdownToHtml', () => {
  it('wraps the body in a printable document with an escaped title', () => {
    const html = markdownToHtml('# Hi', { title: 'a <b> & c' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>a &lt;b&gt; &amp; c</title>');
    expect(html).toContain('<h1');
    expect(html).toContain('class="ynot-markdown-body"');
    expect(html).not.toContain('<base');
    expect(html).not.toContain('<style');
    expect(html).toContain('</html>');
  });

  it('adds a <base> for relative links and a <style> for the stylesheet when given', () => {
    const html = markdownToHtml('![x](a.png)', {
      title: 't',
      baseHref: 'file:///D:/docs/"q"/',
      stylesheet: 'body { color: red }',
    });
    expect(html).toContain('<base href="file:///D:/docs/&quot;q&quot;/">');
    expect(html).toContain('<style>\nbody { color: red }\n</style>');
    expect(html.indexOf('<base')).toBeLessThan(html.indexOf('<style'));
    expect(html.indexOf('<style')).toBeLessThan(html.indexOf('</head>'));
  });

  it('omits <base> for a null or empty baseHref and <style> for an empty stylesheet', () => {
    expect(markdownToHtml('x', { title: 't', baseHref: null, stylesheet: '' })).not.toContain(
      '<base',
    );
    expect(markdownToHtml('x', { title: 't', baseHref: '', stylesheet: '' })).not.toContain(
      '<style',
    );
  });
});

describe('escaping', () => {
  it('escapes text and, for attributes, quotes too', () => {
    expect(escapeText('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; "d"');
    expect(escapeAttribute('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;');
    expect(escapeText('')).toBe('');
  });
});

describe('fileUrl', () => {
  it('turns a Windows path into a file URL with encoded spaces and hashes', () => {
    expect(fileUrl('D:\\a b\\c#d.html')).toBe('file:///D:/a%20b/c%23d.html');
    expect(fileUrl('C:\\x\\what?.html')).toBe('file:///C:/x/what%3F.html');
  });

  it('turns a POSIX path into a file URL', () => {
    expect(fileUrl('/home/x/y.html')).toBe('file:///home/x/y.html');
    expect(fileUrl('//server/share/y.html')).toBe('file:///server/share/y.html');
  });
});

describe('folderUrl', () => {
  it('ends with a slash and drops the file name', () => {
    expect(folderUrl('D:\\a b\\c#d.html')).toBe('file:///D:/a%20b/');
    expect(folderUrl('/home/x/y.html')).toBe('file:///home/x/');
    expect(folderUrl('/y.html')).toBe('file:///');
    expect(folderUrl('lonely.html')).toBe('file:///');
  });
});
