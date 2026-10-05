import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type StageOptions = {
  source: string;
  target: string;
  // Exit status of the batch gate run with --require-batch; 0 means a declared
  // current screen batch is complete.
  runGate: () => number;
};

// Vietnamese is hidden by default: drop any earlier copy, then stage the
// fork-owned catalog only when a declared current screen batch
// (locale-fork/batches.json) is complete per bin/check-vietnamese-batch.mts.
// No declared batch, an invalid manifest or an incomplete batch all withhold.
export function stageVietnamese({ source, target, runGate }: StageOptions): {
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
  if (!fs.existsSync(source)) {
    console.error(`Vietnamese WITHHELD: ${source} does not exist.`);
    return { staged: false };
  }
  fs.copyFileSync(source, target);
  console.log(
    `Vietnamese staged: declared screen batch complete; copied to ${target}.`,
  );
  return { staged: true };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
        ],
        { cwd: root, stdio: 'inherit' },
      ).status ?? 1,
  });
  // Withholding is a normal outcome: packaging continues without Vietnamese.
  console.log(`Vietnamese batch staged: ${result.staged}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
