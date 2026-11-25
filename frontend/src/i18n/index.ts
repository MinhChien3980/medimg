import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './locales/en';
import { vi, type Messages } from './locales/vi';

export const SUPPORTED_LANGUAGES = ['vi', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const LANGUAGE_STORAGE_KEY = 'medimg.lang';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: Messages };
  }
}

function isLanguage(value: string | null): value is Language {
  return value !== null && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // storage unavailable (private mode): use the default
  }
  return 'vi';
}

// Registered before init so the initial language is applied too.
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  document.title = i18n.t('common.documentTitle');
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  } catch {
    // storage unavailable: the choice only lasts for this page load
  }
});

void i18n.use(initReactI18next).init({
  resources: { vi: { translation: vi }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: 'vi',
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
