/**
 * A small namespace-aware XMP reader and patcher (M72, ADR 0017).
 *
 * The rule this file exists to keep: **what we do not own, we do not touch.** A PDF's XMP packet
 * routinely carries a PDF/A identification block, an `xmpMM` provenance history, an Illustrator
 * or InDesign packet, rights-management statements and whatever else produced the file. Editing
 * the title must leave every one of them exactly where it was, so the packet is parsed in
 * document order (fast-xml-parser's `preserveOrder`), only the properties named in
 * {@link XmpFacts} are replaced, and the tree is written back.
 *
 * Two forms of the same property exist and both are handled: the element form
 * (`<pdf:Producer>x</pdf:Producer>`) and the compact attribute form
 * (`<rdf:Description pdf:Producer="x"/>`). Setting a property removes every occurrence of either,
 * in every `rdf:Description`, and writes one element form back — otherwise a file that carried
 * both would come out still carrying the old one.
 *
 * Prefixes are never assumed. `dc:` is a *convention*, not part of the format: a packet may bind
 * the Dublin Core namespace to any prefix it likes, so every tag is resolved through the
 * `xmlns:` declarations in scope, and a property is written with whatever prefix the packet
 * already uses for its namespace.
 */

import { XMLParser } from 'fast-xml-parser';
import { XMP_NS, type XmpFacts, type XmpReading } from './types';

/** One node of fast-xml-parser's `preserveOrder` tree: one tag key, plus `:@` for attributes. */
type XmlNode = Record<string, unknown>;

const ATTRS = ':@';
const TEXT = '#text';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
});

/*
 * The packet is serialised here rather than with fast-xml-parser's builder, for two reasons.
 * The builder is deprecated in version 5 (it has moved to a package of its own), and — the
 * reason that would stand anyway — it re-indents what it writes. Re-indentation is a change to
 * every line of a document we were asked to leave alone, and because the parser keeps the
 * original whitespace as text nodes it would also add a level of indentation on every save until
 * the packet was mostly spaces. Writing the nodes back exactly as they were read leaves an
 * untouched region byte-identical and makes a repeated patch idempotent.
 */

/** XML text, escaped. Attribute values escape the quote as well. */
function escapeXml(value: string, inAttribute = false): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return inAttribute ? escaped.replace(/"/g, '&quot;') : escaped;
}

function serialise(nodes: ReadonlyArray<XmlNode>): string {
  let out = '';
  for (const node of nodes) {
    const text = node[TEXT];
    if (typeof text === 'string') {
      out += escapeXml(text);
      continue;
    }
    const tag = tagOf(node);
    if (tag === null) continue;
    let open = `<${tag}`;
    for (const [name, value] of Object.entries(attrsOf(node))) {
      open += ` ${name.slice(2)}="${escapeXml(value, true)}"`;
    }
    const children = childrenOf(node);
    // Empty elements keep their end tag: `<rdf:Description …></rdf:Description>` is what every
    // XMP producer writes, and a self-closing form would be a gratuitous difference.
    out += `${open}>${serialise(children)}</${tag}>`;
  }
  return out;
}

// ---- tree helpers -------------------------------------------------------------------------------

/** The tag name of a node, or null for a text node. */
function tagOf(node: XmlNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ATTRS && key !== TEXT) return key;
  }
  return null;
}

function childrenOf(node: XmlNode): XmlNode[] {
  const tag = tagOf(node);
  const value = tag === null ? undefined : node[tag];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

function attrsOf(node: XmlNode): Record<string, string> {
  const attrs = node[ATTRS];
  return typeof attrs === 'object' && attrs !== null ? (attrs as Record<string, string>) : {};
}

/** All text directly inside a node, concatenated. */
function textOf(node: XmlNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    const text = child[TEXT];
    if (typeof text === 'string') out += text;
  }
  return out.trim();
}

function element(tag: string, children: XmlNode[], attrs?: Record<string, string>): XmlNode {
  const node: XmlNode = { [tag]: children };
  if (attrs && Object.keys(attrs).length > 0) node[ATTRS] = attrs;
  return node;
}

function textNode(value: string): XmlNode {
  return { [TEXT]: value };
}

/** Prefix → namespace URI, as declared by the `xmlns:` attributes of one element. */
type Scope = ReadonlyMap<string, string>;

function extendScope(scope: Scope, node: XmlNode): Scope {
  let next: Map<string, string> | null = null;
  for (const [name, value] of Object.entries(attrsOf(node))) {
    if (name.startsWith('@_xmlns:')) {
      next ??= new Map(scope);
      next.set(name.slice('@_xmlns:'.length), value);
    }
  }
  return next ?? scope;
}

/** Splits `pdf:Producer` into its prefix and local name. */
function splitName(name: string): { prefix: string; local: string } {
  const colon = name.indexOf(':');
  return colon < 0
    ? { prefix: '', local: name }
    : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/** True when a tag or attribute name resolves to `uri`/`local` in `scope`. */
function matches(name: string, scope: Scope, uri: string, local: string): boolean {
  const split = splitName(name);
  return split.local === local && scope.get(split.prefix) === uri;
}

// ---- the packet ---------------------------------------------------------------------------------

/** A parsed packet: the whole tree, the `rdf:RDF` element, and the namespace scope around it. */
interface Packet {
  readonly tree: XmlNode[];
  readonly rdf: XmlNode;
  readonly rdfScope: Scope;
  /** The `<?xpacket begin=…?>` and `<?xpacket end=…?>` instructions, when the input had them. */
  readonly header: string | null;
  readonly trailer: string | null;
}

const DEFAULT_HEADER = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>';
const DEFAULT_TRAILER = '<?xpacket end="w"?>';
/** The conventional 2 KB of padding that makes a packet rewritable in place. */
const PADDING = `${' '.repeat(99)}\n`.repeat(20);

/** Finds the first element matching `uri`/`local`, depth first, with the scope around it. */
function findElement(
  nodes: ReadonlyArray<XmlNode>,
  scope: Scope,
  uri: string,
  local: string,
): { node: XmlNode; scope: Scope } | null {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === null) continue;
    const inner = extendScope(scope, node);
    if (matches(tag, inner, uri, local)) return { node, scope: inner };
    const hit = findElement(childrenOf(node), inner, uri, local);
    if (hit) return hit;
  }
  return null;
}

/** Splits the packet into its processing instructions and its XML. Never throws. */
function parsePacket(packet: string): Packet | null {
  const beginMatch = /<\?xpacket begin=[\s\S]*?\?>/.exec(packet);
  const endMatch = /<\?xpacket end=[\s\S]*?\?>/.exec(packet);
  const body = packet
    .replace(/<\?xpacket[\s\S]*?\?>/g, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .trim();
  let tree: XmlNode[];
  try {
    tree = parser.parse(body) as XmlNode[];
  } catch {
    return null;
  }
  const rdf = findElement(tree, new Map(), XMP_NS.rdf, 'RDF');
  if (!rdf) return null;
  return {
    tree,
    rdf: rdf.node,
    rdfScope: rdf.scope,
    header: beginMatch ? beginMatch[0] : null,
    trailer: endMatch ? endMatch[0] : null,
  };
}

/** A packet with nothing in it but an empty `rdf:Description`. */
function emptyPacket(): Packet {
  const description = element('rdf:Description', [], { '@_rdf:about': '' });
  const rdf = element('rdf:RDF', [description], { '@_xmlns:rdf': XMP_NS.rdf });
  const meta = element('x:xmpmeta', [rdf], {
    '@_xmlns:x': XMP_NS.x,
    '@_x:xmptk': 'ynotPDF',
  });
  const scope = new Map([
    ['x', XMP_NS.x],
    ['rdf', XMP_NS.rdf],
  ]);
  return { tree: [meta], rdf, rdfScope: scope, header: null, trailer: null };
}

/** Every `rdf:Description` under `rdf:RDF`, each with the namespace scope it sits in. */
function descriptions(packet: Packet): Array<{ node: XmlNode; scope: Scope }> {
  const out: Array<{ node: XmlNode; scope: Scope }> = [];
  const rdfScope = extendScope(packet.rdfScope, packet.rdf);
  for (const child of childrenOf(packet.rdf)) {
    const tag = tagOf(child);
    if (tag === null) continue;
    const scope = extendScope(rdfScope, child);
    if (matches(tag, scope, XMP_NS.rdf, 'Description')) out.push({ node: child, scope });
  }
  return out;
}

// ---- reading ------------------------------------------------------------------------------------

/** The value of one property, in whichever of the two forms the packet used. */
function readProperty(packet: Packet, uri: string, local: string): XmlNode | string | null {
  for (const { node, scope } of descriptions(packet)) {
    for (const [name, value] of Object.entries(attrsOf(node))) {
      if (name.startsWith('@_') && matches(name.slice(2), scope, uri, local)) return value;
    }
    for (const child of childrenOf(node)) {
      const tag = tagOf(child);
      if (tag !== null && matches(tag, extendScope(scope, child), uri, local)) return child;
    }
  }
  return null;
}

/** `<rdf:Alt><rdf:li xml:lang="x-default">…` → the default-language text. */
function readLangAlt(packet: Packet, node: XmlNode | string): string {
  if (typeof node === 'string') return node;
  const scope = extendScope(packet.rdfScope, node);
  const container = childrenOf(node).find((child) => {
    const tag = tagOf(child);
    return tag !== null && matches(tag, extendScope(scope, child), XMP_NS.rdf, 'Alt');
  });
  if (!container) return textOf(node);
  const items = childrenOf(container).filter((child) => tagOf(child) !== null);
  const preferred =
    items.find((item) => attrsOf(item)['@_xml:lang'] === 'x-default') ?? items[0] ?? null;
  return preferred ? textOf(preferred) : '';
}

/** `<rdf:Seq>` / `<rdf:Bag>` → its items' text. */
function readArray(packet: Packet, node: XmlNode | string): string[] {
  if (typeof node === 'string') return [node];
  const scope = extendScope(packet.rdfScope, node);
  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === null) continue;
    const inner = extendScope(scope, child);
    if (
      matches(tag, inner, XMP_NS.rdf, 'Seq') ||
      matches(tag, inner, XMP_NS.rdf, 'Bag') ||
      matches(tag, inner, XMP_NS.rdf, 'Alt')
    ) {
      return childrenOf(child)
        .filter((item) => tagOf(item) !== null)
        .map((item) => textOf(item))
        .filter((text) => text !== '');
    }
  }
  const text = textOf(node);
  return text === '' ? [] : [text];
}

/** Every `pdfx:` property in a packet, whatever prefix it binds that namespace to. */
function customPropertiesOf(packet: Packet): Record<string, string> {
  const custom: Record<string, string> = {};
  for (const { node, scope } of descriptions(packet)) {
    for (const [name, value] of Object.entries(attrsOf(node))) {
      if (!name.startsWith('@_')) continue;
      const split = splitName(name.slice(2));
      if (scope.get(split.prefix) === XMP_NS.pdfx) custom[split.local] = value;
    }
    for (const child of childrenOf(node)) {
      const tag = tagOf(child);
      if (tag === null) continue;
      const split = splitName(tag);
      if (extendScope(scope, child).get(split.prefix) === XMP_NS.pdfx) {
        custom[split.local] = textOf(child);
      }
    }
  }
  return custom;
}

/** What a packet says about the properties we own. A packet we cannot parse says nothing. */
export function readXmp(packet: string | null | undefined): XmpReading {
  const custom: Record<string, string> = {};
  const parsed = packet ? parsePacket(packet) : null;
  if (!parsed) return { custom };

  const simple = (uri: string, local: string): string | undefined => {
    const value = readProperty(parsed, uri, local);
    if (value === null) return undefined;
    const text = typeof value === 'string' ? value : textOf(value);
    return text === '' ? undefined : text;
  };
  const langAlt = (uri: string, local: string): string | undefined => {
    const value = readProperty(parsed, uri, local);
    if (value === null) return undefined;
    const text = readLangAlt(parsed, value);
    return text === '' ? undefined : text;
  };
  const joined = (uri: string, local: string): string | undefined => {
    const value = readProperty(parsed, uri, local);
    if (value === null) return undefined;
    const items = readArray(parsed, value);
    return items.length === 0 ? undefined : items.join('; ');
  };

  Object.assign(custom, customPropertiesOf(parsed));

  const trappedText = simple(XMP_NS.pdf, 'Trapped');
  const trapped =
    trappedText === 'True' || trappedText === 'False' || trappedText === 'Unknown'
      ? trappedText
      : undefined;
  return {
    ...optional('title', langAlt(XMP_NS.dc, 'title')),
    ...optional('author', joined(XMP_NS.dc, 'creator')),
    ...optional('subject', langAlt(XMP_NS.dc, 'description')),
    ...optional('keywords', simple(XMP_NS.pdf, 'Keywords')),
    ...optional('creator', simple(XMP_NS.xmp, 'CreatorTool')),
    ...optional('producer', simple(XMP_NS.pdf, 'Producer')),
    ...optional('created', simple(XMP_NS.xmp, 'CreateDate')),
    ...optional('modified', simple(XMP_NS.xmp, 'ModifyDate')),
    ...(trapped === undefined ? {} : { trapped }),
    custom,
  };
}

// ---- writing ------------------------------------------------------------------------------------

/** True for a text node holding nothing but whitespace — the packet's own indentation. */
function isBlankText(node: XmlNode): boolean {
  const text = node[TEXT];
  return typeof text === 'string' && text.trim() === '';
}

/**
 * Removes every occurrence of one property, in either form, from every description.
 *
 * The blank text node in front of a removed element goes with it, so setting the same property
 * twice produces the same packet rather than one blank line longer each time.
 */
function removeProperty(packet: Packet, uri: string, local: string): void {
  for (const { node, scope } of descriptions(packet)) {
    const attrs = attrsOf(node);
    const kept_attrs = Object.fromEntries(
      Object.entries(attrs).filter(
        ([name]) => !(name.startsWith('@_') && matches(name.slice(2), scope, uri, local)),
      ),
    );
    node[ATTRS] = kept_attrs;
    const tag = tagOf(node);
    if (tag === null) continue;
    const kept: XmlNode[] = [];
    for (const child of childrenOf(node)) {
      const childTag = tagOf(child);
      if (childTag !== null && matches(childTag, extendScope(scope, child), uri, local)) {
        const previous = kept[kept.length - 1];
        if (previous && isBlankText(previous)) kept.pop();
        continue;
      }
      kept.push(child);
    }
    node[tag] = kept;
  }
}

/**
 * The prefix to write a namespace with, declaring it on the target description when the packet
 * does not already bind it. An existing binding always wins: rewriting someone else's `dcterms:`
 * as `dc:` would be a change to a packet we were asked to leave alone.
 */
function prefixFor(packet: Packet, target: Target, uri: string, preferred: string): string {
  for (const [prefix, bound] of target.scope) if (bound === uri) return prefix;
  // A prefix another description already binds to this namespace is reused, so one packet does
  // not end up calling Dublin Core `dc` in one place and `dublin` in another. It still has to be
  // declared here: a namespace is in scope only where it is bound.
  let prefix = preferred;
  for (const { scope } of descriptions(packet)) {
    const found = [...scope].find(([, bound]) => bound === uri);
    if (found) {
      prefix = found[0];
      break;
    }
  }
  const attrs = attrsOf(target.node);
  attrs[`@_xmlns:${prefix}`] = uri;
  target.node[ATTRS] = attrs;
  target.scope.set(prefix, uri);
  return prefix;
}

/** The description new properties go into, with a scope that grows as declarations are added. */
interface Target {
  readonly node: XmlNode;
  readonly scope: Map<string, string>;
}

/** The description properties are written into: the first one, or a new one when there is none. */
function targetDescription(packet: Packet): Target {
  const existing = descriptions(packet)[0];
  if (existing) return { node: existing.node, scope: new Map(existing.scope) };
  const node = element('rdf:Description', [], { '@_rdf:about': '' });
  const rdfTag = tagOf(packet.rdf);
  if (rdfTag !== null) packet.rdf[rdfTag] = [...childrenOf(packet.rdf), node];
  return { node, scope: new Map(extendScope(packet.rdfScope, packet.rdf)) };
}

/**
 * Appends an element, preceded by whatever indentation the surrounding packet uses.
 *
 * A blank text node already at the end is *replaced* rather than added to. Two adjacent blanks
 * would come back from the parser as one node on the next read, and a removal would then take
 * both — so the packet would drift by a blank line every time it was saved.
 */
function appendChild(node: XmlNode, child: XmlNode, indent: string): void {
  const tag = tagOf(node);
  if (tag === null) return;
  const children = childrenOf(node);
  const last = children[children.length - 1];
  const before = last && isBlankText(last) ? children.slice(0, -1) : children;
  node[tag] = [...before, textNode(indent), child];
}

/** The whitespace the description already puts in front of its children, or a sensible default. */
function indentOf(node: XmlNode): string {
  for (const child of childrenOf(node)) {
    if (isBlankText(child)) {
      const text = child[TEXT];
      if (typeof text === 'string' && text.includes('\n')) return text;
    }
  }
  return '\n   ';
}

/**
 * Applies `facts` to a packet, or builds one when there is none (M72).
 *
 * Returns `null` only when there is nothing to write at all — no packet and no facts — so a
 * caller can leave the file's `/Metadata` entry alone rather than adding an empty one.
 */
export function patchXmp(packet: string | null | undefined, facts: XmpFacts): string | null {
  const parsed = (packet ? parsePacket(packet) : null) ?? (packet ? emptyPacket() : null);
  const base = parsed ?? emptyPacket();
  const hasFacts =
    Object.entries(facts).some(([key, value]) => key !== 'custom' && value !== undefined) ||
    Object.keys(facts.custom ?? {}).length > 0;
  if (!parsed && !hasFacts) return null;

  const target = targetDescription(base);
  const rdfPrefix = prefixFor(base, target, XMP_NS.rdf, 'rdf');
  const indent = indentOf(target.node);

  /** Writes one property, or removes it when the value is null. */
  const write = (
    uri: string,
    preferred: string,
    local: string,
    value: string | null | undefined,
    shape: 'text' | 'alt' | 'seq' | 'bag',
  ): void => {
    if (value === undefined) return;
    removeProperty(base, uri, local);
    if (value === null || value === '') return;
    const prefix = prefixFor(base, target, uri, preferred);
    const name = `${prefix}:${local}`;
    if (shape === 'text') {
      appendChild(target.node, element(name, [textNode(value)]), indent);
      return;
    }
    if (shape === 'alt') {
      const li = element(`${rdfPrefix}:li`, [textNode(value)], { '@_xml:lang': 'x-default' });
      appendChild(target.node, element(name, [element(`${rdfPrefix}:Alt`, [li])]), indent);
      return;
    }
    // A Seq keeps the author order the reader typed; a Bag is unordered, which keywords are.
    const separator = shape === 'seq' ? /\s*;\s*/ : /\s*[;,]\s*/;
    const items = value
      .split(separator)
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (items.length === 0) return;
    const container = shape === 'seq' ? `${rdfPrefix}:Seq` : `${rdfPrefix}:Bag`;
    appendChild(
      target.node,
      element(name, [
        element(
          container,
          items.map((item) => element(`${rdfPrefix}:li`, [textNode(item)])),
        ),
      ]),
      indent,
    );
  };

  write(XMP_NS.dc, 'dc', 'title', facts.title, 'alt');
  write(XMP_NS.dc, 'dc', 'creator', facts.author, 'seq');
  write(XMP_NS.dc, 'dc', 'description', facts.subject, 'alt');
  // Keywords are written twice on purpose: `pdf:Keywords` is the string the information
  // dictionary holds, and `dc:subject` is the list every XMP-aware tool searches.
  write(XMP_NS.pdf, 'pdf', 'Keywords', facts.keywords, 'text');
  write(XMP_NS.dc, 'dc', 'subject', facts.keywords, 'bag');
  write(XMP_NS.xmp, 'xmp', 'CreatorTool', facts.creator, 'text');
  write(XMP_NS.pdf, 'pdf', 'Producer', facts.producer, 'text');
  write(XMP_NS.xmp, 'xmp', 'CreateDate', facts.created, 'text');
  write(XMP_NS.xmp, 'xmp', 'ModifyDate', facts.modified, 'text');
  write(XMP_NS.xmp, 'xmp', 'MetadataDate', facts.modified, 'text');
  write(XMP_NS.pdf, 'pdf', 'Trapped', facts.trapped, 'text');
  if (facts.custom) {
    // The set is complete, so a `pdfx:` property the packet has and the facts do not is one the
    // reader deleted from the information dictionary; leaving it would put two answers to the
    // same question in one file.
    for (const key of Object.keys(customPropertiesOf(base))) {
      if (!(key in facts.custom)) removeProperty(base, XMP_NS.pdfx, key);
    }
    for (const [key, value] of Object.entries(facts.custom)) {
      const local = xmlName(key);
      if (local === null) continue;
      write(XMP_NS.pdfx, 'pdfx', local, value, 'text');
    }
  }

  const body = serialise(base.tree);
  const header = base.header ?? DEFAULT_HEADER;
  const trailer = base.trailer ?? DEFAULT_TRAILER;
  return `${header}\n${body.trim()}\n${PADDING}${trailer}\n`;
}

/**
 * A custom property's key as an XML element name, or null when it cannot be one.
 *
 * An information-dictionary key is an arbitrary PDF name — "Part number", "£ paid" — and XML
 * element names are not. The rest of the property is still written to the Info dictionary, which
 * *can* hold it; only the XMP mirror is skipped, and skipping is better than emitting a packet
 * no parser will read.
 */
function xmlName(key: string): string | null {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) ? key : null;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
