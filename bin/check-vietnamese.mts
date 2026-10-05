import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function isLocale(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(entry => typeof entry === 'string')
  );
}

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

const pluralCategories: PluralCategory[] = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
];
const vietnamesePluralCategories = new Set(
  new Intl.PluralRules('vi').resolvedOptions().pluralCategories,
);

function pluralGroups(
  catalog: Record<string, string>,
): Map<string, Set<PluralCategory>> {
  const candidates = new Map<
    string,
    { categories: Set<PluralCategory>; usesCount: boolean }
  >();
  for (const [key, value] of Object.entries(catalog)) {
    const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
    if (!match) {
      continue;
    }
    const [, base, category] = match;
    const pluralCategory = category as PluralCategory;
    const candidate = candidates.get(base) ?? {
      categories: new Set<PluralCategory>(),
      usesCount: false,
    };
    candidate.categories.add(pluralCategory);
    candidate.usesCount ||= /\{\{\s*count(?:\s*,[^{}]*)?\s*\}\}/.test(value);
    candidates.set(base, candidate);
  }

  return new Map(
    [...candidates]
      .filter(
        ([, candidate]) => candidate.usesCount || candidate.categories.size > 1,
      )
      .map(([base, candidate]) => [base, candidate.categories]),
  );
}

function requiredVietnameseKeys(english: Record<string, string>): string[] {
  const groups = pluralGroups(english);
  const pluralKeys = new Set(
    [...groups].flatMap(([base, categories]) =>
      [...categories].map(category => `${base}_${category}`),
    ),
  );
  return [
    ...Object.keys(english).filter(key => !pluralKeys.has(key)),
    ...[...groups.keys()].flatMap(base =>
      [...vietnamesePluralCategories].map(category => `${base}_${category}`),
    ),
  ];
}

function placeholders(value: string): string[] | null {
  const interpolationPattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const remaining = value.replace(interpolationPattern, '');
  if (remaining.includes('{{') || remaining.includes('}}')) {
    return null;
  }
  const interpolation = [...value.matchAll(interpolationPattern)].map(
    match =>
      `{{${match[1]
        .replace(/^-\s*/, '-')
        .split(',')
        .map(part => part.trim())
        .join(',')}}}`,
  );
  const components: string[] = [];
  const openTags: string[] = [];
  for (const match of value.matchAll(/<(\/?)(\d+|[a-zA-Z][\w-]*)\s*(\/?)>/g)) {
    const [, closing, tagName, selfClosing] = match;
    components.push(match[0].replace(/\s/g, ''));
    if (closing) {
      if (openTags.pop() !== tagName) {
        return null;
      }
    } else if (
      !selfClosing &&
      !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(
        tagName,
      )
    ) {
      openTags.push(tagName);
    }
  }
  if (openTags.length > 0) {
    return null;
  }
  return [...interpolation, ...components].sort();
}

export function checkVietnamese(
  english: unknown,
  vietnamese: unknown,
): string[] {
  if (!isLocale(english) || Object.keys(english).length === 0) {
    return ['English extraction must be a non-empty flat string catalog.'];
  }
  if (!isLocale(vietnamese)) {
    return ['Vietnamese must be a flat string catalog.'];
  }

  const errors: string[] = [];
  const groups = pluralGroups(english);
  const groupedKeys = new Set(
    [...groups].flatMap(([base, categories]) =>
      [...categories].map(category => `${base}_${category}`),
    ),
  );
  const entriesToCheck: Array<[string, string | undefined]> = Object.entries(
    english,
  ).filter(([key]) => !groupedKeys.has(key));

  for (const [base] of groups) {
    for (const category of vietnamesePluralCategories) {
      const key = `${base}_${category}`;
      if (!Object.hasOwn(english, key)) {
        errors.push(`Missing English plural form: ${key}`);
      }
      entriesToCheck.push([key, english[key]]);
    }
    for (const category of pluralCategories) {
      const key = `${base}_${category}`;
      if (
        !vietnamesePluralCategories.has(category) &&
        Object.hasOwn(vietnamese, key)
      ) {
        errors.push(`Unexpected Vietnamese plural form: ${key}`);
      }
    }
  }

  for (const [key, value] of entriesToCheck) {
    if (value === undefined) {
      continue;
    }
    if (!Object.hasOwn(vietnamese, key)) {
      errors.push(`Missing Vietnamese key: ${key}`);
      continue;
    }
    if (vietnamese[key].trim() === '') {
      errors.push(`Empty Vietnamese translation: ${key}`);
      continue;
    }
    const sourceTokens = placeholders(value);
    const translatedTokens = placeholders(vietnamese[key]);
    if (
      sourceTokens === null ||
      translatedTokens === null ||
      JSON.stringify(sourceTokens) !== JSON.stringify(translatedTokens)
    ) {
      errors.push(`Placeholder mismatch: ${key}`);
    }
  }
  return errors;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-i18n-'));
  try {
    const extraction = spawnSync(
      'yarn',
      ['generate:i18n', '--output', path.join(output, '$LOCALE.json')],
      { cwd: root, stdio: 'inherit' },
    );
    if (extraction.error) {
      throw extraction.error;
    }
    if (extraction.status !== 0) {
      process.exitCode = extraction.status ?? 1;
      return;
    }
    const english = JSON.parse(
      fs.readFileSync(path.join(output, 'en.json'), 'utf8'),
    );
    const vietnamese = JSON.parse(
      fs.readFileSync(
        path.join(root, 'packages/desktop-client/locale-fork/vi.json'),
        'utf8',
      ),
    );
    const errors = checkVietnamese(english, vietnamese);
    const requiredKeys = isLocale(english)
      ? requiredVietnameseKeys(english)
      : [];
    const presentKeys = isLocale(vietnamese)
      ? requiredKeys.filter(key => Object.hasOwn(vietnamese, key)).length
      : 0;
    console.log(
      `Vietnamese batch completeness: ${JSON.stringify({
        complete: errors.length === 0,
        presentKeys,
        requiredKeys: requiredKeys.length,
        errors: errors.length,
      })}`,
    );
    for (const error of errors) {
      console.error(error);
    }
    if (errors.length > 0) {
      console.error(`Vietnamese coverage failed: ${errors.length} errors.`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Vietnamese coverage: ${requiredKeys.length} required keys, 100%.`,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
