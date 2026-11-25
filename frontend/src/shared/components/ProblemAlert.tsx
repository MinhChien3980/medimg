import { Alert, Button } from 'antd';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppError } from '@/api/problem';

interface ProblemAlertProps {
  error: unknown;
  /** Optional heading; defaults to the ProblemDetail `title`. */
  title?: string;
  onRetry?: () => void;
  style?: CSSProperties;
}

/** Renders an RFC 7807 ProblemDetail (or any error) as an Ant Design alert. */
export function ProblemAlert({ error, title, onRetry, style }: ProblemAlertProps) {
  const { t } = useTranslation();
  const e = toAppError(error, t('common.unexpectedError'));
  return (
    <Alert
      type="error"
      showIcon
      style={style}
      title={title ?? e.title ?? e.detail}
      description={
        title || e.title ? (
          <>
            <div>{e.detail}</div>
            {e.fieldErrors.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {e.fieldErrors.map((f, i) => (
                  <li key={`${f.field ?? ''}-${i}`}>
                    {f.field ? <strong>{f.field}: </strong> : null}
                    {f.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : undefined
      }
      action={
        onRetry ? (
          <Button type="link" size="small" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    />
  );
}
