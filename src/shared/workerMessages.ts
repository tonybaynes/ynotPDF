/**
 * Validate the transport envelope before dispatch can remove a pending request.
 * This is not a deep validator for PDF results; each consumer owns its result contract.
 */
export function assertWorkerEnvelope(
  value: unknown,
  protocol: 'engine' | 'writer' | 'ops' | 'convert' | 'export' | 'optimise',
): void {
  if (!record(value)) throw new Error('Malformed worker message');
  const kind = value.kind;
  if (kind === 'ready') return;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1)
    throw new Error('Malformed worker request identifier');
  let valid = false;
  switch (kind) {
    case 'progress':
      valid =
        (finite(value.fraction) ||
          (protocol !== 'engine' && protocol !== 'writer' && value.fraction === null)) &&
        (protocol === 'engine' ||
          typeof value[protocol === 'writer' ? 'phase' : 'message'] === 'string');
      break;
    case 'fail':
      valid =
        protocol === 'engine' &&
        record(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string';
      break;
    case 'failed':
      valid =
        protocol !== 'engine' &&
        typeof value.reason === 'string' &&
        typeof value.message === 'string';
      break;
    case 'ok':
      valid = protocol === 'engine' && Object.hasOwn(value, 'result');
      break;
    case 'done':
      if (protocol === 'writer' || protocol === 'convert') {
        valid =
          value.bytes instanceof Uint8Array &&
          strings(value.warnings) &&
          (protocol === 'writer'
            ? strings(value.applied) && finite(value.appearances)
            : finite(value.pageCount) && typeof value.title === 'string');
      } else {
        valid = protocol !== 'engine' && record(value.result);
      }
      break;
    case 'render':
      valid =
        protocol === 'export' &&
        Number.isSafeInteger(value.token) &&
        Number.isSafeInteger(value.page) &&
        (value.page as number) >= 0 &&
        finite(value.dpi) &&
        value.dpi > 0;
      break;
  }
  if (!valid) throw new Error('Malformed worker message envelope');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}
