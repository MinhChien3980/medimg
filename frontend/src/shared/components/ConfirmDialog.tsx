import { Modal, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  okText: string;
  danger?: boolean;
  /** While the action runs: the OK button spins and the dialog cannot be dismissed. */
  loading?: boolean;
  onOk: () => void;
  onCancel: () => void;
}

/** A controlled confirmation dialog (keeps the action's pending state visible on its button). */
export function ConfirmDialog({
  open,
  title,
  children,
  okText,
  danger,
  loading,
  onOk,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  // Unmounted when closed, so a closed confirmation never lingers in the DOM.
  if (!open) return null;
  return (
    <Modal
      open
      title={title}
      okText={okText}
      cancelText={t('common.cancel')}
      okButtonProps={{ danger }}
      confirmLoading={loading}
      closable={!loading}
      mask={{ closable: !loading }}
      keyboard={!loading}
      cancelButtonProps={{ disabled: loading }}
      onOk={onOk}
      onCancel={onCancel}
    >
      <Typography.Paragraph style={{ marginBottom: 0 }}>{children}</Typography.Paragraph>
    </Modal>
  );
}
