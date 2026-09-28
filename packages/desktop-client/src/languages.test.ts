import { availableLanguages } from './i18n';

test('Vietnamese remains unavailable before UC5 approval', () => {
  expect(availableLanguages).not.toContain('vi');
});
