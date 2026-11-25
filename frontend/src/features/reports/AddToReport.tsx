import { FileImageOutlined, FileTextOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Input, Modal, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { reportsApi } from '@/api/endpoints';
import { errorMessage } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import { KEY_IMAGE_CAPTION_MAX, KEY_IMAGE_MAX_COUNT, type ReportDto, type Uuid } from '@/api/types';
import { useCan } from '@/features/auth/permissions';
import { KeyImageTooLargeError, reloadReport, storeReport, useAddKeyImage } from './hooks';
import { currentDraft, defaultLanguage, keyImageSlotsLeft, latestReport } from './reportModel';

/** Link to the study's report page (every role may open it). */
export function ReportLink({ studyId }: { studyId: Uuid }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Tooltip title={t('reports.open')}>
      <Button
        icon={<FileTextOutlined />}
        aria-label={t('reports.open')}
        onClick={() => void navigate(`/studies/${studyId}/report`)}
      >
        {t('reports.short')}
      </Button>
    </Tooltip>
  );
}

interface Captured {
  png: Blob;
  previewUrl: string;
}

export interface AddToReportButtonProps {
  studyId: Uuid;
  /** PNG of what the viewer shows (image, overlays, visible annotations). */
  capture: () => Promise<Blob | null>;
  /** Suggested caption (e.g. the view and slice). */
  defaultCaption: string;
  disabled?: boolean;
}

/**
 * "Add to report": captures the view at once, then asks for a caption and uploads the PNG as a
 * key image of the study's draft report, creating the draft first when the study has no report
 * yet. A signed report is never changed: the user is pointed to its amendment instead.
 */
export function AddToReportButton({
  studyId,
  capture,
  defaultCaption,
  disabled,
}: AddToReportButtonProps) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const can = useCan();
  const queryClient = useQueryClient();
  const add = useAddKeyImage();
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [caption, setCaption] = useState('');
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!captured) return;
    return () => URL.revokeObjectURL(captured.previewUrl);
  }, [captured]);

  if (!can('report')) return null;

  const start = async () => {
    setCapturing(true);
    try {
      const png = await capture();
      if (!png) {
        void message.error(t('reports.addImage.captureFailed'));
        return;
      }
      setCaption(defaultCaption.slice(0, KEY_IMAGE_CAPTION_MAX));
      setCaptured({ png, previewUrl: URL.createObjectURL(png) });
    } finally {
      setCapturing(false);
    }
  };

  /** The draft to add to: the existing one, or a new one when the study has no report at all. */
  const targetDraft = async (): Promise<ReportDto | null> => {
    const reports = await queryClient.query({
      queryKey: queryKeys.studies.reports(studyId),
      queryFn: () => reportsApi.forStudy(studyId),
      staleTime: 0,
    });
    const draft = currentDraft(reports);
    // The list holds summaries: read the draft itself (its key images).
    if (draft) return reloadReport(queryClient, draft.id);
    if (latestReport(reports)) {
      void message.warning(t('reports.addImage.signed'));
      return null;
    }
    const created = await reportsApi.create(studyId, { language: defaultLanguage(i18n.language) });
    storeReport(queryClient, created);
    void message.info(t('reports.addImage.draftCreated'));
    return created;
  };

  const submit = async () => {
    if (!captured) return;
    try {
      const draft = await targetDraft();
      if (!draft) return;
      if (keyImageSlotsLeft(draft) === 0) {
        void message.warning(t('reports.addImage.full', { max: KEY_IMAGE_MAX_COUNT }));
        return;
      }
      await add.mutateAsync({ reportId: draft.id, png: captured.png, caption: caption.trim() });
      setCaptured(null);
      // Plain text: messages render outside the router (the "Report" button is next to this one).
      void message.success(t('reports.addImage.done'));
    } catch (e) {
      void message.error(
        e instanceof KeyImageTooLargeError ? t('reports.addImage.tooLarge') : errorMessage(e),
      );
    }
  };

  return (
    <>
      <Tooltip title={t('reports.addImage.tooltip')}>
        <Button
          icon={<FileImageOutlined />}
          loading={capturing}
          disabled={disabled}
          onClick={() => void start()}
        >
          {t('reports.addImage.button')}
        </Button>
      </Tooltip>
      {captured && (
        <Modal
          open
          title={t('reports.addImage.title')}
          okText={t('reports.addImage.submit')}
          cancelText={t('common.cancel')}
          confirmLoading={add.isPending}
          onOk={() => void submit()}
          onCancel={() => setCaptured(null)}
          destroyOnHidden
        >
          <img
            className="key-image-preview"
            src={captured.previewUrl}
            alt={t('reports.addImage.previewAlt')}
          />
          <label className="field-label" htmlFor="key-image-caption">
            {t('reports.keyImages.caption')}
          </label>
          <Input
            id="key-image-caption"
            value={caption}
            maxLength={KEY_IMAGE_CAPTION_MAX}
            showCount
            autoFocus
            onChange={(e) => setCaption(e.target.value)}
            onPressEnter={() => void submit()}
          />
          <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
            {t('reports.addImage.hint', { max: KEY_IMAGE_MAX_COUNT })}
          </Typography.Paragraph>
        </Modal>
      )}
    </>
  );
}
