/**
 * The converter registry (M91, ADR 0011): which converter takes which file.
 *
 * Routing prefers the MIME type the source gave (drag-and-drop, clipboard) and falls back to
 * the extension. The registry is plain data over the converters, so a later module (M93's
 * Office bridge) registers its own and every caller — Create, drag-and-drop, M40's insert, M41's
 * combine, M120's batch — sees it at once.
 */

import { BlankConverter } from './blank/BlankConverter';
import { HtmlConverter } from './html/HtmlConverter';
import { ImageConverter } from './images/ImageConverter';
import { TextConverter } from './text/TextConverter';
import { ConvertUnsupported, extensionOf, type Converter, type RoutingInput } from './types';
import { WebConverter } from './web/WebConverter';

export class ConverterRegistry {
  private readonly converters: Converter[] = [];

  /** Registers a converter; a second one with the same id replaces the first. */
  register(converter: Converter): void {
    const at = this.converters.findIndex((c) => c.id === converter.id);
    if (at >= 0) this.converters[at] = converter;
    else this.converters.push(converter);
  }

  all(): ReadonlyArray<Converter> {
    return this.converters;
  }

  get(id: string): Converter | undefined {
    return this.converters.find((c) => c.id === id);
  }

  /** The converter for a file, or `undefined` when nothing takes it. */
  find(input: RoutingInput): Converter | undefined {
    const mime = input.mime?.toLowerCase();
    if (mime) {
      const byMime = this.converters.find((c) => c.mimes.includes(mime));
      if (byMime) return byMime;
    }
    const ext = extensionOf(input.name);
    if (ext) return this.converters.find((c) => c.extensions.includes(ext));
    return undefined;
  }

  /** Like {@link find} but throws a worded {@link ConvertUnsupported}. */
  require(input: RoutingInput): Converter {
    const found = this.find(input);
    if (found) return found;
    const what = input.name ?? input.mime ?? 'this file';
    throw new ConvertUnsupported(
      'unknown-format',
      `${what} is not a kind of file ynotPDF can turn into a PDF`,
    );
  }

  /** True when some converter routes a file with this name or MIME type. */
  accepts(input: RoutingInput): boolean {
    return this.find(input) !== undefined;
  }

  /** Every extension any converter accepts, for file dialogs and drop handling. */
  extensions(): string[] {
    const all = new Set<string>();
    for (const c of this.converters) for (const e of c.extensions) all.add(e);
    return [...all].sort();
  }

  /**
   * Groups inputs the way Create treats them: files a multi-input converter takes become one
   * group per converter; every other file is a group of its own. Files nothing accepts come
   * back separately so the caller can name them.
   */
  group(inputs: ReadonlyArray<RoutingInput>): {
    readonly groups: ReadonlyArray<{
      readonly converter: Converter;
      readonly inputs: ReadonlyArray<RoutingInput>;
    }>;
    readonly rejected: ReadonlyArray<RoutingInput>;
  } {
    const groups: { converter: Converter; inputs: RoutingInput[] }[] = [];
    const rejected: RoutingInput[] = [];
    for (const input of inputs) {
      const converter = this.find(input);
      if (!converter) {
        rejected.push(input);
        continue;
      }
      const existing = converter.multi ? groups.find((g) => g.converter === converter) : undefined;
      if (existing) existing.inputs.push(input);
      else groups.push({ converter, inputs: [input] });
    }
    return { groups, rejected };
  }
}

/** A registry with every built-in converter. */
export function createRegistry(): ConverterRegistry {
  const registry = new ConverterRegistry();
  registry.register(new ImageConverter());
  registry.register(new TextConverter());
  registry.register(new HtmlConverter());
  registry.register(new WebConverter());
  registry.register(new BlankConverter());
  return registry;
}
