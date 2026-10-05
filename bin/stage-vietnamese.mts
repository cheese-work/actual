import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocale } from './check-vietnamese.mts';

type StageOptions = {
  source: string;
  target: string;
  // Exit status of the batch gate run with --require-batch; 0 means a declared
  // current screen batch is complete.
  runGate: () => number;
  // Vietnamese keys that gate validated (batch + shared keys, plural groups
  // expanded to the Vietnamese plural forms). Read only after the gate passes.
  keys: () => string[];
};

// Vietnamese is hidden by default: drop any earlier copy, then stage the
// fork-owned catalog only when a declared current screen batch
// (locale-fork/batches.json) is complete per bin/check-vietnamese-batch.mts.
// No declared batch, an invalid manifest or an incomplete batch all withhold.
// What ships is a filtered catalogue of exactly the validated keys, in source
// order; translations outside the batch are never staged.
export function stageVietnamese({
  source,
  target,
  runGate,
  keys,
}: StageOptions): {
  staged: boolean;
} {
  fs.rmSync(target, { force: true });
  const status = runGate();
  if (status !== 0) {
    console.error(
      `Vietnamese WITHHELD: no complete declared screen batch (gate exit ${status}); vi is not staged and stays out of Settings > Language.`,
    );
    return { staged: false };
  }
  let catalogue: unknown;
  try {
    catalogue = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (error) {
    console.error(
      `Vietnamese WITHHELD: ${source}: ${(error as Error).message}`,
    );
    return { staged: false };
  }
  const validated = new Set(keys());
  if (!isLocale(catalogue) || validated.size === 0) {
    console.error(`Vietnamese WITHHELD: no validated keys in ${source}.`);
    return { staged: false };
  }
  const filtered = Object.fromEntries(
    Object.entries(catalogue).filter(([key]) => validated.has(key)),
  );
  if (Object.keys(filtered).length !== validated.size) {
    console.error(`Vietnamese WITHHELD: ${source} lacks a validated key.`);
    return { staged: false };
  }
  fs.writeFileSync(target, `${JSON.stringify(filtered, null, 2)}\n`);
  console.log(
    `Vietnamese staged: declared screen batch complete; wrote ${validated.size} validated keys to ${target} (out-of-batch translations are not staged).`,
  );
  return { staged: true };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-vi-'));
  const keysFile = path.join(scratch, 'keys.json');
  try {
    const result = stageVietnamese({
      source: path.join(root, 'packages/desktop-client/locale-fork/vi.json'),
      target: path.join(root, 'packages/desktop-client/locale/vi.json'),
      runGate: () =>
        spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            path.join(root, 'bin/check-vietnamese-batch.mts'),
            '--require-batch',
            '--keys-out',
            keysFile,
          ],
          { cwd: root, stdio: 'inherit' },
        ).status ?? 1,
      keys: () => {
        try {
          return JSON.parse(fs.readFileSync(keysFile, 'utf8'));
        } catch {
          return []; // no key list from the gate: nothing is validated
        }
      },
    });
    // Withholding is a normal outcome: packaging continues without Vietnamese.
    console.log(`Vietnamese batch staged: ${result.staged}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
