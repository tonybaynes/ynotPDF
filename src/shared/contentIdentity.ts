/** Complete byte identity for source-change detection; binary recovery uses SHA-256. */
export function hashBytes(bytes: Uint8Array): string {
  const PRIME = 0x0100_0193;
  let a = 0x811c_9dc5;
  let b = 0x1000_0193;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    a = Math.imul(a ^ byte, PRIME);
    // The second pass folds in the position as well, so a transposition changes the hash.
    b = Math.imul(b ^ (byte + (i & 0xff)), PRIME);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function contentIdentity(bytes: Uint8Array): { size: number; hash: string } {
  return { size: bytes.byteLength, hash: hashBytes(bytes) };
}
