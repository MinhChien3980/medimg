import { Button, Result } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useCan, type Permission } from './permissions';

/**
 * Renders `children` only when the signed-in user has `permission`, otherwise a 403 page whose
 * text is `body` (default: the read-only explanation).
 */
export function RequirePermission({
  permission,
  children,
  body,
}: {
  permission: Permission;
  children: ReactNode;
  body?: string;
}) {
  const { t } = useTranslation();
  const can = useCan();
  const navigate = useNavigate();
  if (can(permission)) return children;
  return (
    <Result
      status="403"
      title={t('errors.forbiddenTitle')}
      subTitle={body ?? t('errors.forbiddenBody')}
      extra={
        <Button type="primary" onClick={() => void navigate('/')}>
          {t('common.goHome')}
        </Button>
      }
    />
  );
}
