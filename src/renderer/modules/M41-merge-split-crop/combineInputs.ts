import { invoke } from '@shared/ipc';
import type { OpSource } from '@engine/ops/types';
import { entryFor, type CombineEntry } from './combineDialog';

export interface CombineInput {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly path?: string;
}

export interface CombineAddResult {
  readonly entries: ReadonlyArray<CombineEntry>;
  readonly problems: ReadonlyArray<string>;
}

export interface CombineReadHooks {
  readonly signal: AbortSignal;
  readonly progress: (message: string) => void;
}

type SourceFor = (
  input: CombineInput,
  hooks: {
    readonly signal: AbortSignal;
    readonly progress: (fraction: number | null, message: string) => void;
  },
) => Promise<OpSource>;

/** Read and convert sequentially; a bad input is named without losing the readable files. */
async function readInputs(
  inputs: ReadonlyArray<{ readonly name: string; read(): Promise<CombineInput> }>,
  sourceFor: SourceFor,
  hooks: CombineReadHooks,
): Promise<CombineAddResult> {
  const entries: CombineEntry[] = [];
  const problems: string[] = [];
  for (const [index, input] of inputs.entries()) {
    if (hooks.signal.aborted) break;
    hooks.progress(`Reading ${input.name} (${String(index + 1)} of ${String(inputs.length)})`);
    try {
      const file = await input.read();
      if (hooks.signal.aborted) break;
      const source = await sourceFor(file, {
        signal: hooks.signal,
        progress: (_fraction, message) => {
          hooks.progress(message);
        },
      });
      if (hooks.signal.aborted) break;
      entries.push(entryFor(source.name, source.bytes, file.path));
    } catch (error) {
      if (hooks.signal.aborted) break;
      problems.push(`${input.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, problems };
}

export function addCombineFiles(
  files: ReadonlyArray<CombineInput>,
  sourceFor: SourceFor,
  hooks: CombineReadHooks,
): Promise<CombineAddResult> {
  return readInputs(
    files.map((file) => ({ name: file.name, read: () => Promise.resolve(file) })),
    sourceFor,
    hooks,
  );
}

/** The folder was selected natively; existing IPC enforces its descendant read grant. */
export async function addCombineFolder(
  folder: string,
  recursive: boolean,
  sourceFor: SourceFor,
  hooks: CombineReadHooks,
): Promise<CombineAddResult> {
  const files = await invoke('file:readFolder', folder, { recursive, limit: 5000 });
  const result = await readInputs(
    files.map((file) => ({ name: file.relativePath, read: () => invoke('file:read', file.path) })),
    sourceFor,
    hooks,
  );
  return {
    entries: result.entries,
    problems: [
      ...result.problems,
      ...(files.length === 5000
        ? [
            'The folder listing reached 5000 files. Add smaller folders to include any remaining files.',
          ]
        : []),
      ...(files.length === 0 ? ['This folder contains no readable files.'] : []),
    ],
  };
}

/** Browser File bytes are the desktop drop's authority. Never turn a drop path into a grant. */
export function addCombineDrop(
  files: ReadonlyArray<File>,
  sourceFor: SourceFor,
  hooks: CombineReadHooks,
): Promise<CombineAddResult> {
  return readInputs(
    files.map((file) => ({
      name: file.name,
      read: async () => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }),
    })),
    sourceFor,
    hooks,
  );
}
