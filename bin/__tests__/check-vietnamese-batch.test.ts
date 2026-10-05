import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateBatch,
  exitCode,
  parseManifest,
} from '../check-vietnamese-batch.mts';
import { checkVietnamese } from '../check-vietnamese.mts';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// Screen A is the declared batch; Screen B is unrelated and untranslated.
const screenA: Record<string, string> = {
  Budget: 'Budget',
  'Balance {{amount}}': 'Balance {{amount}}',
  'Open <0>account</0>': 'Open <0>account</0>',
  '{{count}} items_one': '{{count}} item',
  '{{count}} items_other': '{{count}} items',
};
const english: Record<string, string> = { ...screenA, Reports: 'Reports' };
const viA: Record<string, string> = {
  Budget: 'Ngân sách',
  'Balance {{amount}}': 'Số dư {{amount}}',
  'Open <0>account</0>': 'Mở <0>tài khoản</0>',
  '{{count}} items_other': '{{count}} món',
};
const manifest = (
  keys = ['Budget', 'Balance {{amount}}', 'Open <0>account</0>'],
  sharedKeys = ['{{count}} items'],
) => ({ version: 1, current: { name: 'screen-a', keys, sharedKeys } });
const without = (catalog: Record<string, string>, key: string) =>
  Object.fromEntries(Object.entries(catalog).filter(([k]) => k !== key));

describe('batch gate semantics', () => {
  it('passes a complete batch while an unrelated English key is untranslated (F1)', () => {
    // The old whole-catalogue check fails on the very same inputs.
    expect(checkVietnamese(english, viA)).toEqual([
      'Missing Vietnamese key: Reports',
    ]);
    const result = evaluateBatch(manifest(), english, viA);
    expect(result).toMatchObject({
      state: 'complete',
      batch: 'screen-a',
      required: 4,
      present: 4,
      errors: [],
      complete: true,
    });
    expect(exitCode(result, true)).toBe(0);
  });

  it('fails when a required in-batch key is removed and names it', () => {
    const result = evaluateBatch(manifest(), english, without(viA, 'Budget'));
    expect(result).toMatchObject({ state: 'incomplete', complete: false });
    expect(result.errors).toEqual(['Missing Vietnamese key: Budget']);
    expect(result.present).toBe(3);
    expect(exitCode(result, false)).toBe(1);
    expect(exitCode(result, true)).toBe(1);
  });

  it('requires shared keys, including plural groups by base key', () => {
    const result = evaluateBatch(
      manifest(),
      english,
      without(viA, '{{count}} items_other'),
    );
    expect(result.errors).toEqual([
      'Missing Vietnamese key: {{count}} items_other',
    ]);
  });

  it.each<[string, Record<string, string>, string]>([
    [
      'empty translation',
      { ...viA, Budget: '  ' },
      'Empty Vietnamese translation: Budget',
    ],
    [
      'placeholder mismatch',
      { ...viA, 'Balance {{amount}}': 'Số dư' },
      'Placeholder mismatch: Balance {{amount}}',
    ],
    [
      'unclosed <Trans> tag',
      { ...viA, 'Open <0>account</0>': 'Mở <0>tài khoản' },
      'Placeholder mismatch: Open <0>account</0>',
    ],
    [
      'mismatched <Trans> tag order',
      { ...viA, 'Open <0>account</0>': '</0>tài khoản<0>' },
      'Placeholder mismatch: Open <0>account</0>',
    ],
    [
      'unsupported plural form',
      { ...viA, '{{count}} items_one': '{{count}} món' },
      'Unexpected Vietnamese plural form: {{count}} items_one',
    ],
  ])('fails an in-batch %s', (_name, vi, error) => {
    const result = evaluateBatch(manifest(), english, vi);
    expect(result.errors).toContain(error);
    expect(exitCode(result, false)).toBe(1);
  });

  it('ignores a malformed out-of-batch key but fails the same defect in-batch', () => {
    const richEnglish = {
      ...english,
      'Open <1>report</1>': 'Open <1>report</1>',
    };
    const malformedB = { ...viA, 'Open <1>report</1>': 'Mở <1>báo cáo' };
    expect(evaluateBatch(manifest(), richEnglish, malformedB).complete).toBe(
      true,
    );
    const inBatch = evaluateBatch(
      manifest([...manifest().current.keys, 'Open <1>report</1>']),
      richEnglish,
      malformedB,
    );
    expect(inBatch.errors).toEqual([
      'Placeholder mismatch: Open <1>report</1>',
    ]);
  });

  it('fails stale/unknown keys and plural member keys', () => {
    expect(
      evaluateBatch(manifest(['Budget', 'Gone'], []), english, viA).errors,
    ).toEqual(['Unknown batch key (not in English extraction): Gone']);
    expect(
      evaluateBatch(manifest(['Budget'], ['{{count}} items_one']), english, viA)
        .errors,
    ).toEqual([
      'Plural form listed; use the base key instead: {{count}} items_one',
    ]);
  });

  it('fails when the English extraction is unusable', () => {
    expect(evaluateBatch(manifest(), {}, viA).complete).toBe(false);
    expect(evaluateBatch(manifest(), english, null).complete).toBe(false);
  });

  it('treats no declared batch as withheld; CI passes, staging does not', () => {
    const result = evaluateBatch({ version: 1, current: null }, english, viA);
    expect(result).toMatchObject({
      state: 'none',
      batch: null,
      complete: false,
    });
    expect(exitCode(result, false)).toBe(0);
    expect(exitCode(result, true)).toBe(1);
  });
});

describe('manifest validation fails closed', () => {
  it.each<[string, unknown, string]>([
    ['non-object', 'x', 'Manifest must be a JSON object.'],
    ['null', null, 'Manifest must be a JSON object.'],
    ['array', [], 'Manifest must be a JSON object.'],
    [
      'missing current',
      { version: 1 },
      'Manifest must have exactly "version" and "current".',
    ],
    [
      'extra field',
      { version: 1, current: null, x: 1 },
      'Manifest must have exactly "version" and "current".',
    ],
    [
      'wrong version',
      { version: 2, current: null },
      'Unsupported manifest version: 2.',
    ],
    [
      'string version',
      { version: '1', current: null },
      'Unsupported manifest version: "1".',
    ],
    [
      'bad current',
      { version: 1, current: [] },
      '"current" must be null or { name, keys, sharedKeys }.',
    ],
    [
      'extra batch field',
      { version: 1, current: { ...manifest().current, x: 1 } },
      '"current" must be null or { name, keys, sharedKeys }.',
    ],
    [
      'blank name',
      { version: 1, current: { name: ' ', keys: ['a'], sharedKeys: [] } },
      '"current.name" must be a non-empty string.',
    ],
    [
      'empty keys',
      manifest([], []),
      '"current.keys" must be a non-empty array of strings.',
    ],
    [
      'non-string key',
      manifest([1 as unknown as string], []),
      '"current.keys" must be a non-empty array of strings.',
    ],
    [
      'bad sharedKeys',
      { version: 1, current: { name: 'a', keys: ['a'], sharedKeys: 'x' } },
      '"current.sharedKeys" must be an array of strings.',
    ],
    [
      'duplicate key',
      manifest(['Budget', 'Budget'], []),
      'Duplicate batch key: Budget',
    ],
    [
      'key also shared',
      manifest(['Budget'], ['Budget']),
      'Duplicate batch key: Budget',
    ],
  ])('rejects %s', (_name, raw, error) => {
    expect(parseManifest(raw).errors).toEqual([error]);
    const result = evaluateBatch(raw, english, viA);
    expect(result.state).toBe('invalid');
    expect(exitCode(result, false)).toBe(1);
  });

  it('the shipped manifest is valid', () => {
    const shipped = JSON.parse(
      fs.readFileSync(
        path.join(root, 'packages/desktop-client/locale-fork/batches.json'),
        'utf8',
      ),
    );
    expect(parseManifest(shipped).errors).toEqual([]);
  });
});

describe('CLI (the exact command CI runs: yarn check:i18n)', () => {
  let dir: string;
  const write = (name: string, value: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    return file;
  };
  const run = (manifestValue: unknown, vi: unknown, extra: string[] = []) => {
    const args = [
      '--manifest',
      write('batches.json', manifestValue),
      '--english',
      write('en.json', english),
      '--vietnamese',
      write('vi.json', vi),
      ...extra,
    ];
    return spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'bin/check-vietnamese-batch.mts', ...args],
      { cwd: root, encoding: 'utf8' },
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-batch-cli-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('exits 0 for a complete batch and prints the result line', () => {
    const out = run(manifest(), viA);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(
      'Vietnamese batch completeness: {"batch":"screen-a","required":4,"present":4,"errors":0,"complete":true}',
    );
  });

  it('exits 1 naming the missing in-batch key', () => {
    const out = run(manifest(), without(viA, 'Budget'));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('Missing Vietnamese key: Budget');
    expect(out.stdout).toContain('"complete":false');
  });

  it('exits 0 loudly on the honest empty state; --require-batch exits 1', () => {
    const empty = { version: 1, current: null };
    const out = run(empty, viA);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('No screen batch declared');
    expect(out.stdout).toContain('"complete":false');
    expect(run(empty, viA, ['--require-batch']).status).toBe(1);
  });

  it('exits 1 for a malformed, unreadable or wrong-version manifest', () => {
    expect(run('{not json', viA).status).toBe(1);
    expect(run({ version: 9, current: null }, viA).status).toBe(1);
    const missing = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'bin/check-vietnamese-batch.mts',
        '--manifest',
        path.join(dir, 'absent.json'),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(missing.status).toBe(1);
  });

  it('--catalogue reports the whole-catalogue count as information only', () => {
    const out = run(manifest(), viA, ['--catalogue']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(
      'information only, NOT an enable signal): {"presentKeys":4,"requiredKeys":5,"errors":1}',
    );
  });
});

describe('required CI enforcement', () => {
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('yarn check:i18n runs the batch gate', () => {
    expect(JSON.parse(read('package.json')).scripts['check:i18n']).toBe(
      'node --experimental-strip-types bin/check-vietnamese-batch.mts',
    );
  });

  it('the coverage workflow runs check:i18n as a failing step', () => {
    const workflow = read('.github/workflows/vietnamese-coverage.yml');
    expect(workflow).toMatch(/^\s+run: yarn check:i18n$/m);
    expect(workflow).toMatch(/^\s+run: yarn vitest run --project bin$/m);
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).not.toMatch(/\|\|\s*true/);
    expect(workflow).toMatch(/^\s+pull_request:/m);
  });

  it('Electron forwards --skip-translations to the nested browser build', () => {
    const script = read('bin/package-electron');
    expect(script).toContain('BROWSER_ARGS+=(--skip-translations)');
    expect(script).toContain('yarn build:browser "$' + '{BROWSER_ARGS[@]}"');
  });
});
