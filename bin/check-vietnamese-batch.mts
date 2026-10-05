import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkVietnamese,
  isLocale,
  pluralGroups,
  requiredVietnameseKeys,
} from './check-vietnamese.mts';

// Screen-batch gate (CHE-830 UC5 / CHE-831). The reviewed manifest
// packages/desktop-client/locale-fork/batches.json declares the current screen
// batch; only that batch (keys + sharedKeys) must be translated. Keys outside
// the batch are ignored. No declared batch means Vietnamese stays withheld.

export type Batch = { name: string; keys: string[]; sharedKeys: string[] };
export type BatchState = 'none' | 'invalid' | 'incomplete' | 'complete';
export type BatchResult = {
  state: BatchState;
  batch: string | null;
  required: number;
  present: number;
  errors: string[];
  complete: boolean;
  // Vietnamese keys the gate validated (batch + shared keys, plural groups
  // expanded to the Vietnamese plural forms); only set when complete.
  keys: string[];
};

const keyList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every(entry => typeof entry === 'string' && entry !== '');

export function parseManifest(raw: unknown): {
  batch: Batch | null;
  errors: string[];
} {
  const fail = (message: string) => ({ batch: null, errors: [message] });
  const exactKeys = (value: object, expected: string[]) =>
    Object.keys(value).sort().join() === expected.join();

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('Manifest must be a JSON object.');
  }
  if (!exactKeys(raw, ['current', 'version'])) {
    return fail('Manifest must have exactly "version" and "current".');
  }
  const { version, current } = raw as { version: unknown; current: unknown };
  if (version !== 1) {
    return fail(`Unsupported manifest version: ${JSON.stringify(version)}.`);
  }
  if (current === null) {
    return { batch: null, errors: [] };
  }
  if (
    typeof current !== 'object' ||
    Array.isArray(current) ||
    !exactKeys(current, ['keys', 'name', 'sharedKeys'])
  ) {
    return fail('"current" must be null or { name, keys, sharedKeys }.');
  }
  const { name, keys, sharedKeys } = current as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '') {
    return fail('"current.name" must be a non-empty string.');
  }
  if (!keyList(keys) || keys.length === 0) {
    return fail('"current.keys" must be a non-empty array of strings.');
  }
  if (!keyList(sharedKeys)) {
    return fail('"current.sharedKeys" must be an array of strings.');
  }
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const key of [...keys, ...sharedKeys]) {
    if (seen.has(key)) {
      errors.push(`Duplicate batch key: ${key}`);
    }
    seen.add(key);
  }
  return errors.length > 0
    ? { batch: null, errors }
    : { batch: { name, keys, sharedKeys }, errors: [] };
}

export function evaluateBatch(
  manifest: unknown,
  english: unknown,
  vietnamese: unknown,
): BatchResult {
  const result = (
    state: BatchState,
    batch: string | null,
    errors: string[],
    required = 0,
    present = 0,
    keys: string[] = [],
  ): BatchResult => ({
    state,
    batch,
    required,
    present,
    errors,
    complete: state === 'complete',
    keys: state === 'complete' ? keys : [],
  });

  const parsed = parseManifest(manifest);
  if (parsed.errors.length > 0) {
    return result('invalid', null, parsed.errors);
  }
  if (parsed.batch === null) {
    return result('none', null, []);
  }
  const { name, keys, sharedKeys } = parsed.batch;
  if (!isLocale(english) || Object.keys(english).length === 0) {
    return result('incomplete', name, [
      'English extraction must be a non-empty flat string catalog.',
    ]);
  }

  // Expand each batch key (plural groups by base key) to its English entries,
  // then reuse the unchanged global checker on just that subset.
  const groups = pluralGroups(english);
  const memberKeys = new Set(
    [...groups].flatMap(([base, categories]) =>
      [...categories].map(category => `${base}_${category}`),
    ),
  );
  const subset: Record<string, string> = {};
  const errors: string[] = [];
  for (const key of [...keys, ...sharedKeys]) {
    const categories = groups.get(key);
    if (categories) {
      for (const category of categories) {
        subset[`${key}_${category}`] = english[`${key}_${category}`];
      }
    } else if (memberKeys.has(key)) {
      errors.push(`Plural form listed; use the base key instead: ${key}`);
    } else if (Object.hasOwn(english, key)) {
      subset[key] = english[key];
    } else {
      errors.push(`Unknown batch key (not in English extraction): ${key}`);
    }
  }
  if (Object.keys(subset).length === 0) {
    return result('incomplete', name, errors);
  }
  errors.push(...checkVietnamese(subset, vietnamese));
  const requiredKeys = requiredVietnameseKeys(subset);
  const present = isLocale(vietnamese)
    ? requiredKeys.filter(key => Object.hasOwn(vietnamese, key)).length
    : 0;
  return result(
    errors.length === 0 ? 'complete' : 'incomplete',
    name,
    errors,
    requiredKeys.length,
    present,
    requiredKeys,
  );
}

// Staging needs a complete declared batch; CI treats "none" as an honest
// empty state. In-batch errors and invalid manifests always fail.
export function exitCode(result: BatchResult, requireBatch: boolean): number {
  if (result.state === 'complete') {
    return 0;
  }
  return result.state === 'none' && !requireBatch ? 0 : 1;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {
  manifest: path.join(root, 'packages/desktop-client/locale-fork/batches.json'),
  vietnamese: path.join(root, 'packages/desktop-client/locale-fork/vi.json'),
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`${file}: ${(error as Error).message}`);
    return undefined;
  }
}

function extractEnglish(): Record<string, string> {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-i18n-'));
  try {
    const extraction = spawnSync(
      'yarn',
      ['generate:i18n', '--output', path.join(output, '$LOCALE.json')],
      { cwd: root, stdio: ['ignore', 2, 2] },
    );
    if (extraction.status !== 0) {
      throw new Error(`generate:i18n failed: ${extraction.status}`);
    }
    return JSON.parse(fs.readFileSync(path.join(output, 'en.json'), 'utf8'));
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const options = {
    ...defaults,
    english: '',
    keysOut: '',
    catalogue: false,
    require: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--catalogue') {
      options.catalogue = true;
    } else if (arg === '--require-batch') {
      options.require = true;
    } else if (arg === '--manifest') {
      options.manifest = argv[++i];
    } else if (arg === '--keys-out') {
      options.keysOut = argv[++i];
    } else if (arg === '--english') {
      options.english = argv[++i];
    } else if (arg === '--vietnamese') {
      options.vietnamese = argv[++i];
    } else {
      console.error(`Unknown argument: ${arg}`);
      return 2;
    }
  }
  const english = () =>
    options.english ? readJson(options.english) : extractEnglish();

  if (options.catalogue) {
    // Information only: whole-catalogue count, never the enable signal.
    const en = english();
    const vi = readJson(options.vietnamese);
    const required = isLocale(en) ? requiredVietnameseKeys(en) : [];
    console.log(
      `Vietnamese catalogue (information only, NOT an enable signal): ${JSON.stringify(
        {
          presentKeys: isLocale(vi)
            ? required.filter(key => Object.hasOwn(vi, key)).length
            : 0,
          requiredKeys: required.length,
          errors: checkVietnamese(en, vi).length,
        },
      )}`,
    );
    return 0;
  }

  if (options.keysOut) {
    fs.rmSync(options.keysOut, { force: true });
  }
  const manifest = readJson(options.manifest);
  // Catalogs are only needed (and extraction only run) once a batch is declared.
  const declared = parseManifest(manifest).batch !== null;
  const result = evaluateBatch(
    manifest,
    declared ? english() : null,
    declared ? readJson(options.vietnamese) : null,
  );
  console.log(
    `Vietnamese batch completeness: ${JSON.stringify({
      batch: result.batch,
      required: result.required,
      present: result.present,
      errors: result.errors.length,
      complete: result.complete,
    })}`,
  );
  for (const error of result.errors) {
    console.error(error);
  }
  if (result.state === 'none') {
    console.log(
      'No screen batch declared in locale-fork/batches.json: Vietnamese stays HIDDEN from Settings > Language and is NOT staged. This is not an acceptance of any translation.',
    );
  }
  if (options.keysOut && result.complete) {
    // Consumed by bin/stage-vietnamese.mts: ship exactly these keys, no more.
    fs.writeFileSync(options.keysOut, JSON.stringify(result.keys));
  }
  const code = exitCode(result, options.require);
  if (code !== 0) {
    console.error(`Vietnamese batch gate: ${result.state} (exit ${code}).`);
  }
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
