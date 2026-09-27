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
  const components = [
    ...value.matchAll(/<\/?(?:\d+|[a-zA-Z][\w-]*)\s*\/?>/g),
  ].map(match => match[0].replace(/\s/g, ''));
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
  for (const [key, value] of Object.entries(english)) {
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
    for (const error of errors) {
      console.error(error);
    }
    if (errors.length > 0) {
      console.error(`Vietnamese coverage failed: ${errors.length} errors.`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Vietnamese coverage: ${Object.keys(english).length} keys, 100%.`,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
