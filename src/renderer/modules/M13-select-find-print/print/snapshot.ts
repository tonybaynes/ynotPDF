/** Materialise print-only bytes without saving, rebasing, or changing the undo journal. */
import type { Document } from '@core/Document';
import { buildWritePlan } from '@modules/M21-save/plan';
import { WriterClient } from '@modules/M21-save/WriterClient';
import type { PrintAppearanceOptions } from './appearances';
import type { WritePlan } from '@engine/Writer';

export async function printSnapshot(
  document: Document,
  signal?: AbortSignal,
  options: PrintAppearanceOptions = { annotations: true, forms: true },
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const { plan, bytes, revision } = await document.undo.capture(async () => {
    signal?.throwIfAborted();
    const revision = document.undo.revision;
    const { plan: fullPlan, warnings } = buildWritePlan(document);
    if (warnings.length)
      throw new Error(`The print snapshot could not preserve every edit: ${warnings.join('; ')}`);
    // The caller checks print permission before requesting plaintext. Save security stages must
    // not run here: their output is encrypted and the print compositor needs readable objects.
    const plan: WritePlan = {
      ...fullPlan,
      pages: fullPlan.pages.map((page) => ({
        ...page,
        annotations: options.annotations
          ? (page.annotations ?? []).filter(
              (annotation) =>
                annotation.subtype !== 'Unknown' ||
                annotation.properties !== undefined ||
                annotation.insert,
            )
          : [],
      })),
      fields: options.forms ? fullPlan.fields : null,
      form: options.forms ? (fullPlan.form ?? null) : null,
    };
    // An unchanged unknown subtype has no generator and cannot be matched back by its model
    // name. Leave its raw dictionary intact; the print compositor validates its actual /AP.
    const bytes = await document.engine.save(document.handle, { removeSecurity: true });
    return { plan, bytes, revision };
  });
  signal?.throwIfAborted();
  if (!document.undo.isCurrent(revision))
    throw new Error('The document changed while preparing print. Please try again.');
  const writer = WriterClient.spawn();
  const job = writer.write({ bytes: bytes.slice(), plan });
  const cancel = (): void => {
    job.cancel();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await job.promise;
    signal?.throwIfAborted();
    if (result.warnings.length)
      throw new Error(
        `The print snapshot could not preserve every edit: ${result.warnings.join('; ')}`,
      );
    if (!document.undo.isCurrent(revision))
      throw new Error('The document changed while preparing print. Please try again.');
    return result.bytes;
  } finally {
    signal?.removeEventListener('abort', cancel);
    writer.dispose();
  }
}
