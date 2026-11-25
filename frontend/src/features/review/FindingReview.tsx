import { CheckOutlined, CloseOutlined, EditOutlined } from '@ant-design/icons';
import { Button, Checkbox, Form, Input, Modal, Radio, Space, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FINDING_LABEL_MAX,
  FINDING_NOTE_MAX,
  type FindingDto,
  type ReviewDecision,
  type Uuid,
} from '@/api/types';
import { useCan } from '@/features/auth/permissions';
import { formatDateTime } from '@/shared/lib/format';
import { useReviewFinding } from './hooks';
import { displayLabel, isReviewable, REVIEW_STATUS_COLORS, reviewedCount } from './reviewModel';

/** Review state chip; its tooltip says who reviewed it and when. */
export function ReviewStatusTag({ finding }: { finding: FindingDto }) {
  const { t, i18n } = useTranslation();
  const review = finding.review;
  const tag = (
    <Tag
      color={REVIEW_STATUS_COLORS[finding.reviewStatus]}
      className="review-tag"
      data-testid={`review-status-${finding.id}`}
    >
      {finding.source === 'MANUAL'
        ? t('review.manual')
        : t(`review.status.${finding.reviewStatus}`)}
    </Tag>
  );
  if (!review) return tag;
  return (
    <Tooltip
      title={t('review.reviewedBy', {
        name: review.reviewedBy.fullName,
        time: formatDateTime(review.reviewedAt, i18n.language),
      })}
    >
      {tag}
    </Tooltip>
  );
}

/** The doctor's note, and the AI label an edit replaced. */
export function ReviewDetails({ finding }: { finding: FindingDto }) {
  const { t } = useTranslation();
  const review = finding.review;
  if (!review) return null;
  return (
    <span className="review-details">
      {review.status === 'EDITED' && (
        <Typography.Text type="secondary" className="review-details__line">
          {t('review.aiLabel', { label: finding.label })}
        </Typography.Text>
      )}
      {review.note && (
        <Typography.Text type="secondary" italic className="review-details__line">
          {review.note}
        </Typography.Text>
      )}
    </span>
  );
}

interface FindingReviewActionsProps {
  studyId: Uuid;
  finding: FindingDto;
  /** Name shown in accessible labels (e.g. the translated structure name). */
  name?: string;
}

/**
 * Accept / Edit / Reject buttons of one AI finding, for users who may review. Accept and Reject
 * apply at once (keeping the note); Edit opens a dialog for the decision, the corrected label and
 * a note. The change shows immediately and is undone if the server refuses it.
 */
export function FindingReviewActions({ studyId, finding, name }: FindingReviewActionsProps) {
  const { t } = useTranslation();
  const can = useCan();
  const review = useReviewFinding(studyId);
  const [dialog, setDialog] = useState(false);

  if (!can('review') || !isReviewable(finding)) return null;
  const label = name ?? displayLabel(finding);
  const status = finding.reviewStatus;
  const note = finding.review?.note ?? undefined;

  return (
    <Space.Compact size="small" className="review-actions">
      <Tooltip title={t('review.accept')}>
        <Button
          size="small"
          icon={<CheckOutlined />}
          type={status === 'ACCEPTED' ? 'primary' : 'default'}
          aria-pressed={status === 'ACCEPTED'}
          aria-label={t('review.acceptNamed', { name: label })}
          onClick={() => review.mutate({ finding, decision: 'ACCEPTED', note })}
        />
      </Tooltip>
      <Tooltip title={t('review.edit')}>
        <Button
          size="small"
          icon={<EditOutlined />}
          type={status === 'EDITED' ? 'primary' : 'default'}
          aria-pressed={status === 'EDITED'}
          aria-label={t('review.editNamed', { name: label })}
          onClick={() => setDialog(true)}
        />
      </Tooltip>
      <Tooltip title={t('review.reject')}>
        <Button
          size="small"
          icon={<CloseOutlined />}
          danger={status === 'REJECTED'}
          type={status === 'REJECTED' ? 'primary' : 'default'}
          aria-pressed={status === 'REJECTED'}
          aria-label={t('review.rejectNamed', { name: label })}
          onClick={() => review.mutate({ finding, decision: 'REJECTED', note })}
        />
      </Tooltip>
      {dialog && (
        <ReviewDialog
          finding={finding}
          onCancel={() => setDialog(false)}
          onSubmit={(decision, values) => {
            setDialog(false);
            review.mutate({ finding, decision, ...values });
          }}
        />
      )}
    </Space.Compact>
  );
}

interface DialogValues {
  decision: ReviewDecision;
  label: string;
  note: string;
}

function ReviewDialog({
  finding,
  onCancel,
  onSubmit,
}: {
  finding: FindingDto;
  onCancel: () => void;
  onSubmit: (decision: ReviewDecision, values: { label?: string; note?: string }) => void;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<DialogValues>();
  const decision = Form.useWatch('decision', form) ?? 'EDITED';

  return (
    <Modal
      open
      title={t('review.dialogTitle', { label: finding.label })}
      okText={t('review.save')}
      cancelText={t('common.cancel')}
      onCancel={onCancel}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Form<DialogValues>
        form={form}
        layout="vertical"
        initialValues={{
          decision: 'EDITED',
          label: finding.review?.label ?? finding.label,
          note: finding.review?.note ?? '',
        }}
        onFinish={(v) => onSubmit(v.decision, { label: v.label, note: v.note })}
      >
        <Form.Item name="decision" label={t('review.decision')}>
          <Radio.Group
            optionType="button"
            options={(['ACCEPTED', 'EDITED', 'REJECTED'] as const).map((d) => ({
              value: d,
              label: t(`review.status.${d}`),
            }))}
          />
        </Form.Item>
        {decision === 'EDITED' && (
          <Form.Item
            name="label"
            label={t('review.correctedLabel')}
            rules={[
              { required: true, whitespace: true, message: t('review.labelRequired') },
              { max: FINDING_LABEL_MAX, message: t('review.tooLong', { max: FINDING_LABEL_MAX }) },
            ]}
          >
            <Input maxLength={FINDING_LABEL_MAX} showCount autoFocus />
          </Form.Item>
        )}
        <Form.Item name="note" label={t('review.note')}>
          <Input.TextArea maxLength={FINDING_NOTE_MAX} showCount rows={3} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** "Unreviewed only" switch with the progress ("2 of 5 reviewed"). */
export function UnreviewedFilter({
  findings,
  checked,
  onChange,
}: {
  findings: readonly FindingDto[];
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  if (findings.length === 0) return null;
  return (
    <div className="review-filter">
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)}>
        {t('review.unreviewedOnly')}
      </Checkbox>
      <Typography.Text type="secondary" className="review-filter__count" aria-live="polite">
        {t('review.progress', { done: reviewedCount(findings), total: findings.length })}
      </Typography.Text>
    </div>
  );
}
