import { AimOutlined, DeleteOutlined, EditOutlined, LoadingOutlined } from '@ant-design/icons';
import { Button, Empty, Form, Input, Modal, Popconfirm, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ANNOTATION_LABEL_MAX,
  ANNOTATION_NOTE_MAX,
  type AnnotationDto,
  type ArrowGeometry,
} from '@/api/types';
import { ARROW_TEXT_MAX } from './geometry2d';
import { isPendingAnnotation, type AnnotationChange } from './hooks';
import { useAnnotationName, useAnnotationText } from './useAnnotationLabels';

export interface AnnotationsPanelProps {
  /** Annotations of the series on screen, in drawing order. */
  annotations: readonly AnnotationDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Volume only: brings the annotation's slice into view. */
  onLocate?: (annotation: AnnotationDto) => void;
  canEdit: (annotation: AnnotationDto) => boolean;
  onUpdate: (id: string, change: AnnotationChange) => void;
  onDelete: (id: string) => void;
}

/**
 * List of the annotations of the series: select (and, for volumes, jump to the slice), edit the
 * label and note (and an arrow's text) of one's own, delete one's own. Others' annotations are
 * listed read-only with their author.
 */
export function AnnotationsPanel({
  annotations,
  selectedId,
  onSelect,
  onLocate,
  canEdit,
  onUpdate,
  onDelete,
}: AnnotationsPanelProps) {
  const { t } = useTranslation();
  const text = useAnnotationText();
  const nameOf = useAnnotationName();
  const [editing, setEditing] = useState<AnnotationDto | null>(null);

  if (annotations.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('annotations.empty')}
        data-testid="annotations-empty"
      />
    );
  }

  return (
    <>
      <ul className="annotation-list" aria-label={t('annotations.list')}>
        {annotations.map((a, index) => {
          const selected = a.id === selectedId;
          const pending = isPendingAnnotation(a.id);
          const editable = !pending && canEdit(a);
          const measurement = text.measurement(a);
          const title = nameOf(a, index);
          return (
            <li
              key={a.id}
              className={`annotation-row${selected ? ' annotation-row--selected' : ''}`}
              data-testid={`annotation-row-${index}`}
            >
              <button
                type="button"
                className="annotation-row__select"
                aria-pressed={selected}
                onClick={() => {
                  onSelect(a.id);
                  onLocate?.(a);
                }}
              >
                <span className="annotation-row__title">
                  {pending && <LoadingOutlined aria-label={t('annotations.saving')} />} {title}
                </span>
                <span className="annotation-row__meta">
                  {text.kind(a)}
                  {measurement && ` · ${measurement}`}
                </span>
                {a.kind === 'ARROW' && (a.geometry as ArrowGeometry).text && (
                  <span className="annotation-row__meta">
                    “{(a.geometry as ArrowGeometry).text}”
                  </span>
                )}
                {a.note && <span className="annotation-row__note">{a.note}</span>}
                <span className="annotation-row__author">{a.author.fullName}</span>
              </button>
              <span className="annotation-row__actions">
                {onLocate && (
                  <Tooltip title={t('annotations.locate')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<AimOutlined />}
                      aria-label={t('annotations.locateNamed', { name: title })}
                      onClick={() => {
                        onSelect(a.id);
                        onLocate(a);
                      }}
                    />
                  </Tooltip>
                )}
                {editable && (
                  <>
                    <Tooltip title={t('annotations.edit')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        aria-label={t('annotations.editNamed', { name: title })}
                        onClick={() => setEditing(a)}
                      />
                    </Tooltip>
                    <Popconfirm
                      title={t('annotations.deleteConfirm')}
                      okText={t('annotations.delete')}
                      cancelText={t('common.cancel')}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => onDelete(a.id)}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={t('annotations.deleteNamed', { name: title })}
                      />
                    </Popconfirm>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <Typography.Text type="secondary" className="annotation-list__hint">
        {t('annotations.ownOnly')}
      </Typography.Text>
      {editing && (
        <AnnotationEditModal
          annotation={editing}
          onCancel={() => setEditing(null)}
          onSave={(change) => {
            onUpdate(editing.id, change);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

interface EditValues {
  label: string;
  note: string;
  text: string;
}

export function AnnotationEditModal({
  annotation,
  onCancel,
  onSave,
}: {
  annotation: AnnotationDto;
  onCancel: () => void;
  onSave: (change: AnnotationChange) => void;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<EditValues>();
  const arrow = annotation.kind === 'ARROW' ? (annotation.geometry as ArrowGeometry) : null;

  const submit = (values: EditValues) => {
    const change: AnnotationChange = {
      label: values.label.trim() || null,
      note: values.note.trim() || null,
    };
    if (arrow) change.geometry = { ...arrow, text: values.text.trim() };
    onSave(change);
  };

  return (
    <Modal
      open
      title={t('annotations.editTitle')}
      okText={t('annotations.save')}
      cancelText={t('common.cancel')}
      onCancel={onCancel}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Form<EditValues>
        form={form}
        layout="vertical"
        initialValues={{
          label: annotation.label ?? '',
          note: annotation.note ?? '',
          text: arrow?.text ?? '',
        }}
        onFinish={submit}
      >
        {arrow && (
          <Form.Item name="text" label={t('annotations.arrowText')}>
            <Input maxLength={ARROW_TEXT_MAX} showCount autoFocus />
          </Form.Item>
        )}
        <Form.Item name="label" label={t('annotations.label')}>
          <Input maxLength={ANNOTATION_LABEL_MAX} showCount autoFocus={!arrow} />
        </Form.Item>
        <Form.Item name="note" label={t('annotations.note')}>
          <Input.TextArea maxLength={ANNOTATION_NOTE_MAX} showCount rows={3} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
