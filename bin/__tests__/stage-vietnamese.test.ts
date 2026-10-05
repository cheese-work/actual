import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkVietnamese } from '../check-vietnamese.mts';
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

  // Runs the real CHE-831 gate function (checkVietnamese) against the catalog
  // that is about to be staged, as bin/check-vietnamese.mts does for the tree.
  const gate = () =>
    checkVietnamese(english, JSON.parse(fs.readFileSync(source, 'utf8')))
      .length === 0
      ? 0
      : 1;
  const stage = (catalog: Record<string, string>) => {
    fs.writeFileSync(source, JSON.stringify(catalog));
    return stageVietnamese({ source, target, runGate: gate });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-vi-'));
    source = path.join(dir, 'locale-fork-vi.json');
    target = path.join(dir, 'locale', 'vi.json');
    fs.mkdirSync(path.dirname(target));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stages a complete, well-formed batch byte-for-byte', () => {
    expect(stage(complete)).toEqual({ staged: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(
      fs.readFileSync(source, 'utf8'),
    );
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

  it('replaces a stale vi.json only with the gate-approved batch', () => {
    fs.writeFileSync(target, '{"stale":"x"}');
    expect(stage(complete)).toEqual({ staged: true });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(complete);
  });

  it('withholds when the gate cannot run (non-zero status)', () => {
    fs.writeFileSync(source, JSON.stringify(complete));
    expect(stageVietnamese({ source, target, runGate: () => 2 })).toEqual({
      staged: false,
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('withholds when the fork catalog is missing', () => {
    expect(stageVietnamese({ source, target, runGate: () => 0 })).toEqual({
      staged: false,
    });
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
