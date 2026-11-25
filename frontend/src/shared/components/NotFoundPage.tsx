import { Button, Result } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

export default function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title={t('errors.notFoundTitle')}
      subTitle={t('errors.notFoundBody')}
      extra={
        <Button type="primary" onClick={() => void navigate('/')}>
          {t('common.goHome')}
        </Button>
      }
    />
  );
}
