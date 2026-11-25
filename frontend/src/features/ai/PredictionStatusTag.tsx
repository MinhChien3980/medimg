import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  StopOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Tag } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PredictionStatus } from '@/api/types';

const STYLE: Record<PredictionStatus, { color: string; icon: ReactNode }> = {
  QUEUED: { color: 'default', icon: <ClockCircleOutlined /> },
  RUNNING: { color: 'processing', icon: <SyncOutlined spin /> },
  DONE: { color: 'success', icon: <CheckCircleOutlined /> },
  FAILED: { color: 'error', icon: <CloseCircleOutlined /> },
  CANCELLED: { color: 'warning', icon: <StopOutlined /> },
};

export function PredictionStatusTag({ status }: { status: PredictionStatus }) {
  const { t } = useTranslation();
  const s = STYLE[status];
  return (
    <Tag color={s.color} icon={s.icon} data-status={status}>
      {t(`ai.status.${status}`)}
    </Tag>
  );
}
