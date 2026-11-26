import { CopyOutlined } from '@ant-design/icons';
import { Alert, App, Button, Input, Modal, Space, Typography } from 'antd';
import type { InputRef } from 'antd';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface TemporaryPassword {
  username: string;
  password: string;
  /** After creating the account or after a reset. */
  kind: 'created' | 'reset';
}

interface Props {
  value: TemporaryPassword | null;
  onClose: () => void;
}

/**
 * Shows a temporary password once. It lives only in the page's state (never in the query
 * cache), and the dialog only closes through its button, so it cannot be dismissed by a stray
 * click or Esc before it was noted.
 */
export function TemporaryPasswordModal({ value, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const inputRef = useRef<InputRef>(null);
  const inputId = useId();

  const copy = async () => {
    if (!value) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(value.password);
      void message.success(t('admin.users.temp.copied'));
    } catch {
      // No clipboard (plain http on a LAN address, permission denied): select it for Ctrl+C.
      inputRef.current?.select();
      void message.warning(t('admin.users.temp.copyFailed'));
    }
  };

  return (
    <Modal
      open={value !== null}
      title={t('admin.users.temp.title')}
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      // No closing animation: the password leaves the DOM as soon as the dialog closes.
      transitionName=""
      maskTransitionName=""
      destroyOnHidden
      footer={
        <Button type="primary" onClick={onClose}>
          {t('admin.users.temp.done')}
        </Button>
      }
    >
      {value && (
        <>
          <Typography.Paragraph>
            {value.kind === 'created'
              ? t('admin.users.temp.createdIntro', { username: value.username })
              : t('admin.users.temp.resetIntro', { username: value.username })}
          </Typography.Paragraph>
          <label htmlFor={inputId} className="sr-only">
            {t('admin.users.temp.label')}
          </label>
          <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
            <Input
              id={inputId}
              ref={inputRef}
              readOnly
              value={value.password}
              className="temp-password"
              autoComplete="off"
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button icon={<CopyOutlined aria-hidden />} onClick={() => void copy()}>
              {t('admin.users.temp.copy')}
            </Button>
          </Space.Compact>
          <Alert type="warning" showIcon title={t('admin.users.temp.warning')} />
        </>
      )}
    </Modal>
  );
}
