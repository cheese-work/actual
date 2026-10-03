import { runClassic } from 'eslint-vitest-rule-tester';

import plugin from '../../index';

void runClassic(
  'no-untranslated-strings',
  plugin.rules['no-untranslated-strings'],
  {
    valid: [
      '<Trans>Loading...</Trans>',
      '<Input title={t("To:")} />',
      '<span>Actual</span>',
      '<span>AC</span>',
      '<input value="localhost" />',
      '<Select value={enabled ? "year" : "month"} />',
      '<span>{format(date, short ? "MMMM yyyy" : "MMMM d, yyyy")}</span>',
    ],
    invalid: [
      ...['Group:', 'To:', 'Loading...', 'File shared with:'].map(text => ({
        code: `<span>${text}</span>`,
        errors: [{ messageId: 'useTrans' }],
      })),
      {
        code: '<Input title="To:" />',
        errors: [{ messageId: 'useT' }],
      },
    ],
  },
  {
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
);
