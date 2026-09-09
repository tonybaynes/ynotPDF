/**
 * The XMP properties ynotPDF owns (M72, ADR 0017).
 *
 * Deliberately not "the XMP model": a packet can hold anything, and the whole point of
 * `patchXmp` is that what is not named here survives untouched. This is the list of properties
 * that mean the same thing as an entry in the information dictionary, plus the custom
 * properties, which the XMP specification puts in the `pdfx` namespace.
 */

/** Namespace URIs, by the prefix we write when the packet does not already use another. */
export const XMP_NS = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://purl.org/dc/elements/1.1/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  /**
   * Where the XMP specification (Part 2) puts information-dictionary entries that have no
   * standard XMP property — which is what a custom document property is. Acrobat, Foxit and
   * Ghostscript all read and write custom properties here, so a `ynot:` namespace of our own
   * would make ours invisible to every other tool.
   */
  pdfx: 'http://ns.adobe.com/pdfx/1.3/',
} as const;

/**
 * What the Info dictionary and XMP both say.
 *
 * Every field is optional and means "this property is present"; `null` means "remove it".
 * `undefined` — the key absent altogether — means "leave whatever the packet has".
 */
export interface XmpFacts {
  readonly title?: string | null;
  readonly author?: string | null;
  readonly subject?: string | null;
  readonly keywords?: string | null;
  /** Information-dictionary `/Creator`, which XMP calls `xmp:CreatorTool`. */
  readonly creator?: string | null;
  readonly producer?: string | null;
  /** ISO 8601. */
  readonly created?: string | null;
  readonly modified?: string | null;
  readonly trapped?: 'True' | 'False' | 'Unknown' | null;
  /**
   * Custom properties, written to `pdfx:` — **the complete set**, when present.
   *
   * A key mapped to `null` is removed, and so is any `pdfx:` property the packet has that this
   * object does not mention. `pdfx` exists to mirror the information dictionary's custom
   * entries, so a property there that is not in the dictionary is stale by definition, and
   * leaving it would be the one thing this module exists to prevent: two answers to the same
   * question in one file. Omit the key altogether to leave every custom property alone.
   */
  readonly custom?: Readonly<Record<string, string | null>>;
}

/** What a packet says, as far as {@link XmpFacts} describes. Absent means the packet is silent. */
export interface XmpReading {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: string;
  readonly creator?: string;
  readonly producer?: string;
  readonly created?: string;
  readonly modified?: string;
  readonly trapped?: 'True' | 'False' | 'Unknown';
  readonly custom: Readonly<Record<string, string>>;
}
