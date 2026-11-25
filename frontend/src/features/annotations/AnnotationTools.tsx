import {
  ArrowRightOutlined,
  BorderOutlined,
  ColumnWidthOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  StarOutlined,
} from '@ant-design/icons';
import { Button, Input, Modal, Space, Tooltip } from 'antd';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DrawTool } from './AnnotationLayer2D';
import { ANNOTATION_2D_KINDS, ARROW_TEXT_MAX } from './geometry2d';

const TOOL_ICONS: Record<DrawTool, ReactNode> = {
  RECTANGLE: <BorderOutlined />,
  POLYGON: <StarOutlined />,
  ARROW: <ArrowRightOutlined />,
  LENGTH: <ColumnWidthOutlined />,
};

/** Drawing tools (toggle buttons) and the show / hide switch of the annotations. */
export function AnnotationTools({
  tool,
  onTool,
  visible,
  onVisible,
  canDraw,
}: {
  tool: DrawTool | null;
  onTool: (tool: DrawTool | null) => void;
  visible: boolean;
  onVisible: (visible: boolean) => void;
  canDraw: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Space size={4} role="group" aria-label={t('annotations.tools')}>
      {canDraw &&
        ANNOTATION_2D_KINDS.map((kind) => (
          <Tooltip key={kind} title={t(`annotations.toolHints.${kind}`)}>
            <Button
              icon={TOOL_ICONS[kind]}
              type={tool === kind ? 'primary' : 'default'}
              aria-pressed={tool === kind}
              aria-label={t(`annotations.draw.${kind}`)}
              disabled={!visible}
              onClick={() => onTool(tool === kind ? null : kind)}
            />
          </Tooltip>
        ))}
      <Tooltip title={t(visible ? 'annotations.hide' : 'annotations.show')}>
        <Button
          icon={visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
          aria-pressed={visible}
          aria-label={t('annotations.toggleVisible')}
          onClick={() => {
            if (visible) onTool(null);
            onVisible(!visible);
          }}
        />
      </Tooltip>
    </Space>
  );
}

/** Asks for the text of an arrow just drawn (empty is allowed). */
export function ArrowTextDialog({
  onSubmit,
  onCancel,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  return (
    <Modal
      open
      title={t('annotations.arrowTextTitle')}
      okText={t('annotations.save')}
      cancelText={t('common.cancel')}
      onOk={() => onSubmit(text.trim())}
      onCancel={onCancel}
      destroyOnHidden
    >
      <label className="field-label" htmlFor="arrow-text">
        {t('annotations.arrowText')}
      </label>
      <Input
        id="arrow-text"
        value={text}
        maxLength={ARROW_TEXT_MAX}
        showCount
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onPressEnter={() => onSubmit(text.trim())}
      />
    </Modal>
  );
}
