import { I18nextProvider, Trans, useTranslation } from 'react-i18next';

import { act, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

const messageKey = '<0>Themes</0> change the user interface colors.';
const vietnamese =
  '<0>Giao diện</0> thay đổi màu sắc của giao diện người dùng.';

function ThemesMessage() {
  const { t: translate } = useTranslation();
  return (
    <Trans t={translate} i18nKey={messageKey}>
      <strong>Themes</strong> change the user interface colors.
    </Trans>
  );
}

describe('validated Trans message language switching', () => {
  it('keeps the Themes message non-empty when switching en → vi → en', async () => {
    const instance = createInstance();
    await instance.init({
      lng: 'en',
      fallbackLng: false,
      keySeparator: false,
      nsSeparator: false,
      resources: {
        en: { translation: { [messageKey]: messageKey } },
        vi: { translation: { [messageKey]: vietnamese } },
      },
      react: { transSupportBasicHtmlNodes: false },
    });
    const { container } = render(
      <I18nextProvider i18n={instance}>
        <ThemesMessage />
      </I18nextProvider>,
    );

    expect(container).toHaveTextContent(
      'Themes change the user interface colors.',
    );
    await act(async () => {
      await instance.changeLanguage('vi');
    });
    expect(instance.language).toBe('vi');
    expect(container.textContent?.trim()).not.toBe('');
    expect(container).toHaveTextContent(
      'Giao diện thay đổi màu sắc của giao diện người dùng.',
    );
    expect(
      screen.getByText('Giao diện', { selector: 'strong' }),
    ).toBeInTheDocument();

    await act(async () => {
      await instance.changeLanguage('en');
    });
    expect(container.textContent?.trim()).not.toBe('');
    expect(container).toHaveTextContent(
      'Themes change the user interface colors.',
    );
  });
});
