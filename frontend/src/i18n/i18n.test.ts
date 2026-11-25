import { afterEach, describe, expect, it } from 'vitest';
import i18n from '.';

describe('i18n document sync', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('keeps <html lang>, the page title and the stored choice in sync with the language', async () => {
    await i18n.changeLanguage('vi');
    expect(document.documentElement.lang).toBe('vi');
    expect(document.title).toBe('MedImg – AI hình ảnh y khoa');
    expect(localStorage.getItem('medimg.lang')).toBe('vi');

    await i18n.changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('MedImg – Medical imaging AI');
  });
});
