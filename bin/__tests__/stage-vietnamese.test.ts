import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluateBatch, exitCode } from '../check-vietnamese-batch.mts';
import { stageVietnamese } from '../stage-vietnamese.mts';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const english: Record<string, string> = {
  Budget: 'Budget',
  'Balance {{amount}}': 'Balance {{amount}}',
  'Open <0>account</0>': 'Open <0>account</0>',
  '{{count}} items_one': '{{count}} item',
  '{{count}} items_other': '{{count}} items',
  // Screen B is unrelated to the declared batch.
  Reports: 'Reports',
  'Report {{name}}': 'Report {{name}}',
  'Open <0>report</0>': 'Open <0>report</0>',
  '{{count}} reports_one': '{{count}} report',
  '{{count}} reports_other': '{{count}} reports',
};
const batchManifest = {
  version: 1,
  current: {
    name: 'screen-a',
    keys: ['Budget', 'Balance {{amount}}', 'Open <0>account</0>'],
    sharedKeys: ['{{count}} items'],
  },
};
const complete: Record<string, string> = {
  Budget: 'Ngân sách',
  'Balance {{amount}}': 'Số dư {{amount}}',
  'Open <0>account</0>': 'Mở <0>tài khoản</0>',
  '{{count}} items_other': '{{count}} món',
};

describe('stageVietnamese', () => {
  let dir: string;
  let source: string;
  let target: string;

  // Same evaluation + exit mapping as `check-vietnamese-batch.mts --require-batch`.
  let manifest: unknown = batchManifest;
  let englishCatalog = english;
  let validatedKeys: string[] = [];
  const gate = () => {
    const result = evaluateBatch(
      manifest,
      englishCatalog,
      JSON.parse(fs.readFileSync(source, 'utf8')),
    );
    validatedKeys = result.keys;
    return exitCode(result, true);
  };
  const stage = (catalog: Record<string, string>) => {
    fs.writeFileSync(source, JSON.stringify(catalog));
    return stageVietnamese({
      source,
      target,
      runGate: gate,
      keys: () => validatedKeys,
    });
  };
  const staged = () =>
    JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, string>;
  const viPluralKeys = (base: string) =>
    new Intl.PluralRules('vi')
      .resolvedOptions()
      .pluralCategories.map(category => `${base}_${category}`);
  const validatedA = [
    'Budget',
    'Balance {{amount}}',
    'Open <0>account</0>',
    ...viPluralKeys('{{count}} items'),
  ];
  const screenB: Record<string, string> = {
    Reports: 'Báo cáo',
    'Report {{name}}': 'Báo cáo {{name}}',
    'Open <0>report</0>': 'Mở <0>báo cáo</0>',
    '{{count}} reports_other': '{{count}} báo cáo',
  };
  const sortedKeys = (value: Record<string, string>) =>
    Object.keys(value).sort();

  beforeEach(() => {
    manifest = batchManifest;
    englishCatalog = english;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-vi-'));
    source = path.join(dir, 'locale-fork-vi.json');
    target = path.join(dir, 'locale', 'vi.json');
    fs.mkdirSync(path.dirname(target));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stages exactly the validated keys as deterministic 2-space JSON', () => {
    expect(stage(complete)).toEqual({ staged: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(
      `${JSON.stringify(complete, null, 2)}\n`,
    );
    expect(sortedKeys(staged())).toEqual([...validatedA].sort());
  });

  it('F3: complete screen A stages only A while screen B is partial', () => {
    const { Reports: _r, 'Report {{name}}': _n, ...partialB } = screenB;
    expect(stage({ ...partialB, ...complete })).toEqual({ staged: true });
    expect(sortedKeys(staged())).toEqual([...validatedA].sort());
  });

  it('F3: screen B entirely untranslated is not staged', () => {
    expect(stage(complete)).toEqual({ staged: true });
    expect(sortedKeys(staged())).toEqual([...validatedA].sort());
  });

  it.each<[string, Record<string, string>]>([
    ['empty translation', { ...screenB, Reports: ' ' }],
    ['placeholder mismatch', { ...screenB, 'Report {{name}}': 'Báo cáo' }],
    ['unclosed <Trans> tag', { ...screenB, 'Open <0>report</0>': 'Mở <0>báo' }],
    [
      'wrong plural form',
      { ...screenB, '{{count}} reports_one': '{{count}} báo cáo' },
    ],
    ['extra key absent from English', { ...screenB, 'Not in English': 'x' }],
  ])('F3: complete screen A stages only A while screen B has %s', (_n, b) => {
    expect(stage({ ...b, ...complete })).toEqual({ staged: true });
    expect(sortedKeys(staged())).toEqual([...validatedA].sort());
    expect(fs.readFileSync(target, 'utf8')).not.toMatch(/báo|Not in English/);
  });

  it('keeps source key order and stages no non-validated plural variant', () => {
    const interleaved = {
      '{{count}} reports_other': '{{count}} báo cáo',
      Reports: 'Báo cáo',
      '{{count}} items_other': complete['{{count}} items_other'],
      Budget: complete.Budget,
      'Open <0>account</0>': complete['Open <0>account</0>'],
      'Balance {{amount}}': complete['Balance {{amount}}'],
    };
    expect(stage(interleaved)).toEqual({ staged: true });
    expect(Object.keys(staged())).toEqual([
      '{{count}} items_other',
      'Budget',
      'Open <0>account</0>',
      'Balance {{amount}}',
    ]);
    expect(Object.keys(staged())).toEqual(
      expect.arrayContaining(viPluralKeys('{{count}} items')),
    );
    expect(Object.keys(staged()).filter(k => k.includes('reports'))).toEqual(
      [],
    );
  });

  it('stages shared keys alongside batch keys', () => {
    manifest = {
      version: 1,
      current: {
        name: 'screen-a',
        keys: ['Budget'],
        sharedKeys: ['Balance {{amount}}', '{{count}} items'],
      },
    };
    expect(stage(complete)).toEqual({ staged: true });
    expect(sortedKeys(staged())).toEqual(
      [
        'Budget',
        'Balance {{amount}}',
        ...viPluralKeys('{{count}} items'),
      ].sort(),
    );
  });

  it('does not loosen duplicate keys between keys and sharedKeys', () => {
    manifest = {
      version: 1,
      current: { name: 'dup', keys: ['Budget'], sharedKeys: ['Budget'] },
    };
    fs.writeFileSync(target, '{"stale":"x"}');
    expect(stage(complete)).toEqual({ staged: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each<[string, unknown]>([
    ['no declared batch', { version: 1, current: null }],
    ['an invalid manifest', { version: 7, current: null }],
  ])('withholds and removes a stale vi.json with %s', (_name, value) => {
    manifest = value;
    fs.writeFileSync(target, '{"stale":"x"}');
    expect(stage(complete)).toEqual({ staged: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('withholds a partial batch (missing key)', () => {
    const { Budget: _removed, ...partial } = complete;
    expect(stage(partial)).toEqual({ staged: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each<[string, Record<string, string>]>([
    ['empty translation', { ...complete, Budget: '  ' }],
    ['placeholder mismatch', { ...complete, 'Balance {{amount}}': 'Số dư' }],
    [
      'malformed <Trans> tag ordering',
      { ...complete, 'Open <0>account</0>': '</0>tài khoản<0>' },
    ],
    [
      'unclosed <Trans> tag',
      { ...complete, 'Open <0>account</0>': 'Mở <0>tài khoản' },
    ],
    [
      'unsupported Vietnamese plural form',
      { ...complete, '{{count}} items_one': '{{count}} món' },
    ],
    [
      'missing Vietnamese plural form',
      Object.fromEntries(
        Object.entries(complete).filter(([k]) => !k.endsWith('_other')),
      ),
    ],
  ])('withholds %s', (_name, catalog) => {
    expect(stage(catalog)).toEqual({ staged: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('removes a stale vi.json when the batch fails', () => {
    fs.writeFileSync(target, '{"stale":"x"}');
    const { Budget: _removed, ...partial } = complete;
    expect(stage(partial)).toEqual({ staged: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('replaces a stale vi.json only with the gate-approved keys', () => {
    fs.writeFileSync(target, '{"stale":"x"}');
    expect(stage({ ...screenB, ...complete })).toEqual({ staged: true });
    expect(staged()).toEqual(complete);
  });

  it('removes a stale vi.json when a required in-batch key is omitted', () => {
    fs.writeFileSync(target, '{"stale":"x"}');
    const { 'Balance {{amount}}': _removed, ...omitted } = complete;
    expect(stage({ ...screenB, ...omitted })).toEqual({ staged: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('withholds when the gate cannot run (non-zero status)', () => {
    fs.writeFileSync(source, JSON.stringify(complete));
    expect(
      stageVietnamese({
        source,
        target,
        runGate: () => 2,
        keys: () => ['Budget'],
      }),
    ).toEqual({ staged: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('withholds when the fork catalog is missing', () => {
    expect(
      stageVietnamese({
        source,
        target,
        runGate: () => 0,
        keys: () => ['Budget'],
      }),
    ).toEqual({ staged: false });
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('packaging copy sites', () => {
  const sites = [
    'bin/package-browser',
    'bin/package-electron',
    '.github/actions/setup/action.yml',
  ];

  it.each(sites)('%s stages Vietnamese only through the gate', site => {
    const text = fs.readFileSync(path.join(root, site), 'utf8');
    expect(text).toContain('bin/stage-vietnamese.mts');
    expect(text).not.toMatch(/\bcp\b[^\n]*vi\.json/);
  });

  it('no other tracked script or workflow copies vi.json unconditionally', () => {
    const offenders: string[] = [];
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(root, rel), {
        withFileTypes: true,
      })) {
        const child = path.join(rel, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(child);
        } else if (
          /^(bin|\.github)\//.test(child) &&
          !child.includes('__tests__') &&
          /\bcp\b[^\n]*(locale-fork|vi\.json)/.test(
            fs.readFileSync(path.join(root, child), 'utf8'),
          )
        ) {
          offenders.push(child);
        }
      }
    };
    walk('bin');
    walk('.github');
    expect(offenders).toEqual([]);
  });
});
