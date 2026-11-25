import { DeleteOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Skeleton,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/problem';
import { FINDING_LABEL_MAX, FINDING_NOTE_MAX, type FindingDto, type Uuid } from '@/api/types';
import { useCan, useCurrentUserId } from '@/features/auth/permissions';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { useAddFinding, useDeleteFinding, useStudyFindings } from './hooks';
import { manualAuthor } from './reviewModel';

/** The annotation selected in the viewer, offered as the location of a new finding. */
export interface SelectedAnnotation {
  id: Uuid;
  name: string;
}

export interface ManualFindingsProps {
  studyId: Uuid;
  seriesId: Uuid | null;
  selectedAnnotation?: SelectedAnnotation | null;
  /** Selects (and shows) the annotation a finding points at. */
  onShowAnnotation?: (annotationId: Uuid) => void;
}

/**
 * Findings added by doctors (source MANUAL, accepted at once): listed for everyone, added by users
 * who may review, deleted by their author. A new finding can point at the annotation selected in
 * the viewer, e.g. a box drawn around a lesion.
 */
export function ManualFindings({
  studyId,
  seriesId,
  selectedAnnotation,
  onShowAnnotation,
}: ManualFindingsProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const can = useCan();
  const userId = useCurrentUserId();
  const findings = useStudyFindings(studyId);
  const remove = useDeleteFinding(studyId);
  const [adding, setAdding] = useState(false);

  const manual = (findings.data ?? []).filter(
    (f) => f.source === 'MANUAL' && (!seriesId || f.seriesId === seriesId),
  );

  return (
    <div className="manual-findings" data-testid="manual-findings">
      <div className="manual-findings__head">
        <Typography.Text strong>{t('review.manualTitle')}</Typography.Text>
        {can('review') && seriesId && (
          <Button size="small" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
            {t('review.addFinding')}
          </Button>
        )}
      </div>
      {findings.isError && (
        <ProblemAlert error={findings.error} onRetry={() => void findings.refetch()} />
      )}
      {findings.isPending ? (
        <Skeleton active paragraph={{ rows: 1 }} title={false} />
      ) : manual.length === 0 ? (
        <Typography.Text type="secondary" className="manual-findings__empty">
          {t('review.noManual')}
        </Typography.Text>
      ) : (
        <ul className="manual-findings__list">
          {manual.map((f) => (
            <ManualFindingRow
              key={f.id}
              finding={f}
              canDelete={can('review') && manualAuthor(f)?.id === userId}
              deleting={remove.isPending && remove.variables === f.id}
              onDelete={() =>
                remove.mutate(f.id, { onError: (e) => void message.error(errorMessage(e)) })
              }
              onShowAnnotation={onShowAnnotation}
            />
          ))}
        </ul>
      )}
      {adding && seriesId && (
        <AddFindingDialog
          studyId={studyId}
          seriesId={seriesId}
          selectedAnnotation={selectedAnnotation ?? null}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function ManualFindingRow({
  finding,
  canDelete,
  deleting,
  onDelete,
  onShowAnnotation,
}: {
  finding: FindingDto;
  canDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
  onShowAnnotation?: (annotationId: Uuid) => void;
}) {
  const { t } = useTranslation();
  const annotationId = finding.annotationId;
  return (
    <li className="manual-finding">
      <div className="manual-finding__main">
        <span className="manual-finding__label">{finding.label}</span>
        {annotationId && onShowAnnotation && (
          <Tooltip title={t('review.showAnnotation')}>
            <Button
              type="text"
              size="small"
              icon={<LinkOutlined />}
              aria-label={t('review.showAnnotationNamed', { name: finding.label })}
              onClick={() => onShowAnnotation(annotationId)}
            />
          </Tooltip>
        )}
        {canDelete && (
          <Popconfirm
            title={t('review.deleteConfirm')}
            okText={t('review.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={onDelete}
          >
            <Button
              type="text"
              size="small"
              danger
              loading={deleting}
              icon={<DeleteOutlined />}
              aria-label={t('review.deleteNamed', { name: finding.label })}
            />
          </Popconfirm>
        )}
      </div>
      {finding.review?.note && (
        <Typography.Text type="secondary" italic className="manual-finding__note">
          {finding.review.note}
        </Typography.Text>
      )}
      {manualAuthor(finding) && (
        <Typography.Text type="secondary" className="manual-finding__author">
          {manualAuthor(finding)?.fullName}
        </Typography.Text>
      )}
    </li>
  );
}

interface AddValues {
  label: string;
  note: string;
  link: boolean;
}

function AddFindingDialog({
  studyId,
  seriesId,
  selectedAnnotation,
  onClose,
}: {
  studyId: Uuid;
  seriesId: Uuid;
  selectedAnnotation: SelectedAnnotation | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<AddValues>();
  const add = useAddFinding(studyId);

  const submit = (values: AddValues) => {
    const note = values.note.trim();
    add.mutate(
      {
        seriesId,
        label: values.label.trim(),
        ...(note ? { note } : {}),
        ...(values.link && selectedAnnotation ? { annotationId: selectedAnnotation.id } : {}),
      },
      {
        onSuccess: () => {
          void message.success(t('review.added'));
          onClose();
        },
        onError: (e) => void message.error(errorMessage(e)),
      },
    );
  };

  return (
    <Modal
      open
      title={t('review.addTitle')}
      okText={t('review.add')}
      cancelText={t('common.cancel')}
      confirmLoading={add.isPending}
      onCancel={onClose}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Form<AddValues>
        form={form}
        layout="vertical"
        initialValues={{ label: '', note: '', link: !!selectedAnnotation }}
        onFinish={submit}
      >
        <Form.Item
          name="label"
          label={t('review.label')}
          rules={[
            { required: true, whitespace: true, message: t('review.labelRequired') },
            { max: FINDING_LABEL_MAX, message: t('review.tooLong', { max: FINDING_LABEL_MAX }) },
          ]}
        >
          <Input maxLength={FINDING_LABEL_MAX} showCount autoFocus />
        </Form.Item>
        <Form.Item name="note" label={t('review.note')}>
          <Input.TextArea maxLength={FINDING_NOTE_MAX} showCount rows={3} />
        </Form.Item>
        <Form.Item name="link" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Checkbox disabled={!selectedAnnotation}>
            {selectedAnnotation
              ? t('review.linkAnnotation', { name: selectedAnnotation.name })
              : t('review.noAnnotationSelected')}
          </Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}
