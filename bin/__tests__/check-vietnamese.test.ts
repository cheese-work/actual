import { describe, expect, it } from 'vitest';

import { checkVietnamese } from '../check-vietnamese.mts';

describe('Vietnamese coverage gate', () => {
  const english = {
    Budget: 'Budget',
    'Balance {{amount}}': 'Balance {{amount}}',
    'Open <0>account</0>': 'Open <0>account</0>',
  };
  const vietnamese = {
    Budget: 'Ngân sách',
    'Balance {{amount}}': 'Số dư {{amount}}',
    'Open <0>account</0>': 'Mở <0>tài khoản</0>',
  };

  it('turns red on a removed key and green when restored', () => {
    const removed: Partial<typeof vietnamese> = { ...vietnamese };
    delete removed.Budget;
    expect(checkVietnamese(english, removed)).toEqual([
      'Missing Vietnamese key: Budget',
    ]);
    expect(checkVietnamese(english, vietnamese)).toEqual([]);
  });

  it('requires new strings and every extracted plural key', () => {
    expect(
      checkVietnamese(
        {
          ...english,
          Currency: 'Currency',
          '{{count}} items_one': '{{count}} items',
        },
        vietnamese,
      ),
    ).toEqual([
      'Missing Vietnamese key: Currency',
      'Missing Vietnamese key: {{count}} items_one',
    ]);
  });

  it('rejects blank translations and invalid catalogs', () => {
    expect(checkVietnamese({ Budget: 'Budget' }, { Budget: '  ' })).toEqual([
      'Empty Vietnamese translation: Budget',
    ]);
    expect(checkVietnamese({}, vietnamese)).toHaveLength(1);
    for (const invalid of [null, [], { Budget: 5 }, { nested: {} }]) {
      expect(checkVietnamese(english, invalid)).toHaveLength(1);
    }
  });

  it.each([
    ['{{amount}}', '{{total}}'],
    ['{{amount}}', 'Số dư'],
    ['{{amount}}', '{{amount}} {{amount}}'],
    ['{{amount, number}}', '{{amount}}'],
    ['{{- amount}}', '{{amount}}'],
    ['Budget', 'Ngân sách {{amount'],
    ['Budget', 'Ngân sách amount}}'],
    ['<0>account</0>', '<1>tài khoản</1>'],
    ['<0>account</0>', '<0>tài khoản'],
    ['<0>account</0>', '</0>tài khoản<0>'],
    ['<0><1>account</1></0>', '<0><1>tài khoản</0></1>'],
    ['<italic>account</italic>', '</italic>tài khoản<italic>'],
    ['<br/>', 'Dòng'],
  ])('rejects changed placeholders: %s → %s', (source, translation) => {
    expect(checkVietnamese({ key: source }, { key: translation })).toEqual([
      'Placeholder mismatch: key',
    ]);
  });

  it('allows reordered placeholders, whitespace and obsolete translations', () => {
    expect(
      checkVietnamese(
        { key: '{{name}} {{- amount, number}} <0>account</0><br />' },
        {
          key: '<0>tài khoản</0><br/> {{-amount,number }} {{name}}',
          obsolete: 'Cũ',
        },
      ),
    ).toEqual([]);
  });

  it('rejects the reversed Themes tag pair that erases the rendered message', () => {
    const key = '<0>Themes</0> change the user interface colors.';
    expect(
      checkVietnamese(
        { [key]: key },
        {
          [key]: '</0>Giao diện<0> thay đổi màu sắc của giao diện người dùng.',
        },
      ),
    ).toEqual([`Placeholder mismatch: ${key}`]);
    expect(
      checkVietnamese(
        { [key]: key },
        {
          [key]: '<0>Giao diện</0> thay đổi màu sắc của giao diện người dùng.',
        },
      ),
    ).toEqual([]);
  });

  it('allows reordering complete components, nesting and self-closing tags', () => {
    expect(
      checkVietnamese(
        {
          key: '<0>Themes</0> change <1><italic>colors</italic></1><allocatedAmount/><br>',
        },
        {
          key: '<1><italic>màu sắc</italic></1> đổi theo <0>Giao diện</0><allocatedAmount/><br>',
        },
      ),
    ).toEqual([]);
  });
});
