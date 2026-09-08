/**
 * The slice of utif (MIT) that M91 uses. The published `@types/utif` imports Node's types, which
 * the web project deliberately does not have, so the declaration lives here instead.
 */
declare module 'utif' {
  /** One image file directory: `tNNN` keys hold tag values; the decoders add `width`/`height`/`data`. */
  export interface IFD {
    [tag: string]: string[] | number[] | number | Uint8Array | undefined;
    width?: number;
    height?: number;
    data?: Uint8Array;
  }
  export function decode(buffer: ArrayBuffer): IFD[];
  export function decodeImage(buffer: ArrayBuffer, ifd: IFD): void;
  export function toRGBA8(ifd: IFD): Uint8Array;
  export function encodeImage(
    rgba: Uint8Array,
    width: number,
    height: number,
    metadata?: IFD,
  ): ArrayBuffer;
  export function encode(ifds: IFD[]): ArrayBuffer;
}
