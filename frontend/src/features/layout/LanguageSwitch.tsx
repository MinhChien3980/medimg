import { GlobalOutlined } from '@ant-design/icons';
import { Segmented } from 'antd';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, type Language } from '@/i18n';

const LABELS: Record<Language, string> = { vi: 'VI', en: 'EN' };

export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  const value: Language = i18n.language === 'en' ? 'en' : 'vi';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <GlobalOutlined aria-label={t('header.language')} />
      <Segmented<Language>
        size="small"
        value={value}
        options={SUPPORTED_LANGUAGES.map((l) => ({ label: LABELS[l], value: l }))}
        onChange={(lng) => void i18n.changeLanguage(lng)}
      />
    </span>
  );
}
