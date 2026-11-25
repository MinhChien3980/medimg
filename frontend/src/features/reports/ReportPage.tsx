import {
  ArrowLeftOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileAddOutlined,
  FilePdfOutlined,
  ReloadOutlined,
  SyncOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Popconfirm,
  Radio,
  Result,
  Select,
  Skeleton,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { patientsApi, studiesApi } from '@/api/endpoints';
import { errorMessage, toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import {
  REPORT_SECTION_MAX,
  type ReportDto,
  type ReportLanguage,
  type ReportSummaryDto,
  type ReportTemplate,
  type StudyDto,
} from '@/api/types';
import { useCan, useCurrentUserId } from '@/features/auth/permissions';
import { useStudyFindings } from '@/features/review/hooks';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { formatDateTime } from '@/shared/lib/format';
import {
  useAmendReport,
  useCreateReport,
  useDeleteReport,
  useFinalizeReport,
  useRefillReport,
  useReport,
  useStudyReports,
} from './hooks';
import { KeyImagesEditor, KeyImagesView } from './KeyImages';
import { downloadUrl, finalPdfUrl, openPreviewPdf, reportFileName } from './pdf';
import {
  canAmend,
  canFinalize,
  defaultLanguage,
  defaultTemplate,
  pendingKeyImages,
  reviewedSince,
  SECTION_FIELDS,
  visibleReports,
  type SectionField,
} from './reportModel';
import { ReportStatusTag } from './ReportStatusTag';
import { useDraftAutosave, type SaveState } from './useDraftAutosave';

/**
 * `/studies/:studyId/report`: the study's report and its versions. A doctor creates a draft from a
 * template (sections pre-filled by the server from reviewed findings and annotations), edits it
 * (saved automatically), arranges key images captured in the viewers, previews the PDF, then signs
 * it, which makes it FINAL and immutable; changes after that go into an amendment (next version).
 * Researchers only see signed reports.
 */
export default function ReportPage() {
  const { studyId = '' } = useParams();
  const { t } = useTranslation();
  const can = useCan();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const study = useQuery({
    queryKey: queryKeys.studies.detail(studyId),
    queryFn: () => studiesApi.get(studyId),
    enabled: !!studyId,
  });
  const patientId = study.data?.patientId ?? '';
  const patient = useQuery({
    queryKey: queryKeys.patients.detail(patientId),
    queryFn: () => patientsApi.get(patientId),
    enabled: !!patientId,
  });
  const reports = useStudyReports(studyId);
  const all = reports.data ?? [];
  const visible = visibleReports(all, can('viewDraftReport'));
  const selected = visible.find((r) => r.id === selectedId) ?? visible[0] ?? null;
  // The list holds summaries; the selected version is read in full.
  const detail = useReport(selected?.id ?? null);

  if (study.isError && toAppError(study.error).status === 404) {
    return <Result status="404" title={t('viewer.studyNotFound')} />;
  }

  return (
    <div className="page report-page">
      <div className="page__header">
        <div>
          <Space size={16} wrap>
            <Link to={`/studies/${studyId}`} className="back-link">
              <ArrowLeftOutlined /> {t('reports.backToViewer')}
            </Link>
            {patient.data && (
              <Link to={`/cases/${patient.data.id}`} className="back-link">
                {t('reports.caseLink', { code: patient.data.code })}
              </Link>
            )}
          </Space>
          <Typography.Title level={3} style={{ margin: '4px 0 0' }}>
            {t('reports.title')} {selected && <ReportStatusTag report={selected} />}
          </Typography.Title>
          {study.data && (
            <Typography.Text type="secondary">
              {study.data.modality} · {study.data.bodyPart} ·{' '}
              {t(`caseDetail.inputTypes.${study.data.inputType}`)}
            </Typography.Text>
          )}
        </div>
      </div>

      {(study.isError || reports.isError) && (
        <ProblemAlert
          error={study.error ?? reports.error}
          onRetry={() => void reports.refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      {reports.isPending || !study.data ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <div className="report-page__body">
          <main className="report-page__main">
            {!selected ? (
              can('report') ? (
                <CreateReportCard study={study.data} onCreated={(r) => setSelectedId(r.id)} />
              ) : (
                <Card>
                  <Empty
                    description={t(
                      can('viewDraftReport') ? 'reports.noReport' : 'reports.noSignedReport',
                    )}
                  />
                </Card>
              )
            ) : detail.isError ? (
              <ProblemAlert error={detail.error} onRetry={() => void detail.refetch()} />
            ) : !detail.data ? (
              <Skeleton active paragraph={{ rows: 8 }} />
            ) : detail.data.status === 'DRAFT' && can('report') ? (
              <DraftEditor
                key={detail.data.id}
                report={detail.data}
                onDeleted={() => setSelectedId(null)}
              />
            ) : (
              <ReportReadView
                report={detail.data}
                amendable={can('report') && canAmend(detail.data, all)}
                onAmended={(r) => setSelectedId(r.id)}
              />
            )}
          </main>
          <aside className="report-page__side">
            <VersionHistory
              reports={visible}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

// ---------- create ----------

function CreateReportCard({
  study,
  onCreated,
}: {
  study: StudyDto;
  onCreated: (report: ReportDto) => void;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const create = useCreateReport(study.id);
  const [template, setTemplate] = useState<ReportTemplate>(defaultTemplate(study.inputType));
  const [language, setLanguage] = useState<ReportLanguage>(defaultLanguage(i18n.language));

  return (
    <Card title={t('reports.create.title')}>
      <Typography.Paragraph type="secondary">{t('reports.create.intro')}</Typography.Paragraph>
      <Form layout="vertical" style={{ maxWidth: 420 }}>
        <Form.Item label={t('reports.template')} htmlFor="report-template">
          <Select<ReportTemplate>
            id="report-template"
            value={template}
            onChange={setTemplate}
            options={(['CXR', 'CT'] as const).map((v) => ({
              value: v,
              label: t(`reports.templates.${v}`),
            }))}
          />
        </Form.Item>
        <Form.Item label={t('reports.language')}>
          <Radio.Group
            value={language}
            onChange={(e) => setLanguage(e.target.value as ReportLanguage)}
            optionType="button"
            options={[
              { value: 'vi', label: t('reports.languages.vi') },
              { value: 'en', label: t('reports.languages.en') },
            ]}
          />
        </Form.Item>
        <Button
          type="primary"
          icon={<FileAddOutlined />}
          loading={create.isPending}
          onClick={() =>
            create.mutate(
              { template, language },
              {
                onSuccess: (report) => {
                  void message.success(t('reports.create.done'));
                  onCreated(report);
                },
                onError: (e) => void message.error(errorMessage(e)),
              },
            )
          }
        >
          {t('reports.create.submit')}
        </Button>
      </Form>
    </Card>
  );
}

// ---------- draft ----------

const SECTION_ROWS: Record<SectionField, number> = {
  clinicalInfo: 2,
  technique: 3,
  findingsText: 8,
  impression: 4,
};

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  const type = state === 'error' ? 'danger' : state === 'saved' ? 'success' : 'secondary';
  return (
    <Typography.Text type={type} role="status" aria-live="polite" data-testid="save-state">
      {t(`reports.save.${state}`)}
    </Typography.Text>
  );
}

function DraftEditor({ report, onDeleted }: { report: ReportDto; onDeleted: () => void }) {
  const { t, i18n } = useTranslation();
  const { message, modal } = App.useApp();
  const userId = useCurrentUserId();
  const draft = useDraftAutosave(report);
  const finalize = useFinalizeReport();
  const refill = useRefillReport();
  const remove = useDeleteReport();
  const findings = useStudyFindings(report.studyId);
  const [previewing, setPreviewing] = useState(false);
  const missingImages = pendingKeyImages(report);
  const signable = canFinalize(draft.values) && missingImages === 0;
  const reviewedLater = reviewedSince(findings.data ?? [], report.updatedAt) > 0;

  const preview = async () => {
    setPreviewing(true);
    try {
      if (!(await draft.flush())) return;
      const shown = await openPreviewPdf(report);
      if (shown === 'download') void message.info(t('reports.preview.downloaded'));
    } catch (e) {
      void message.error(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  };

  const sign = async () => {
    if (!(await draft.flush())) {
      void message.error(t('reports.sign.notSaved'));
      return;
    }
    modal.confirm({
      title: t('reports.sign.confirmTitle'),
      content: t('reports.sign.confirmBody', { version: report.version }),
      okText: t('reports.sign.confirm'),
      cancelText: t('common.cancel'),
      onOk: () =>
        finalize.mutateAsync(report).then(
          () => void message.success(t('reports.sign.done')),
          (e: unknown) => {
            if (toAppError(e).status === 409) void draft.reload();
            void message.error(errorMessage(e));
          },
        ),
    });
  };

  /** Saves what was typed, then asks before the server rewrites Technique and Findings. */
  const refillSections = async () => {
    if (!(await draft.flush())) {
      void message.error(t('reports.refill.notSaved'));
      return;
    }
    modal.confirm({
      title: t('reports.refill.confirmTitle'),
      content: t('reports.refill.confirmBody'),
      okText: t('reports.refill.confirm'),
      cancelText: t('common.cancel'),
      onOk: () =>
        refill.mutateAsync(report).then(
          (fresh) => {
            draft.replace(fresh);
            void message.success(t('reports.refill.done'));
          },
          (e: unknown) => {
            if (toAppError(e).status === 409) {
              void draft.reload();
              void message.error(t('reports.refill.conflict'));
            } else {
              void message.error(errorMessage(e));
            }
          },
        ),
    });
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={t('reports.draftTitle', { version: report.version })}
        extra={<SaveIndicator state={draft.state} />}
      >
        {report.amendsReportId && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title={t('reports.amendsNotice', { version: report.version - 1 })}
          />
        )}
        {draft.state === 'conflict' && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title={t('reports.conflict.title')}
            description={t('reports.conflict.body')}
            action={
              <Button icon={<ReloadOutlined />} onClick={() => void draft.reload()}>
                {t('reports.conflict.reload')}
              </Button>
            }
          />
        )}
        {reviewedLater && draft.state !== 'conflict' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title={t('reports.refill.staleTitle')}
            description={t('reports.refill.staleBody')}
          />
        )}
        {draft.state === 'error' && (
          <ProblemAlert
            error={draft.error}
            title={t('reports.save.failed')}
            onRetry={() => void draft.flush()}
            style={{ marginBottom: 16 }}
          />
        )}
        <Form layout="vertical">
          {SECTION_FIELDS.map((field) => (
            <Form.Item
              key={field}
              label={t(`reports.sections.${field}`)}
              htmlFor={`report-${field}`}
              required={field === 'impression'}
            >
              <Input.TextArea
                id={`report-${field}`}
                value={draft.values[field]}
                onChange={(e) => draft.change(field, e.target.value)}
                autoSize={{ minRows: SECTION_ROWS[field], maxRows: 20 }}
                maxLength={REPORT_SECTION_MAX[field]}
              />
            </Form.Item>
          ))}
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('reports.templateLine', {
            template: t(`reports.templates.${report.template}`),
            language: t(`reports.languages.${report.language}`),
            time: formatDateTime(report.updatedAt, i18n.language),
          })}
        </Typography.Text>
      </Card>

      <Card title={t('reports.keyImages.title')}>
        <KeyImagesEditor report={report} onChange={(items) => void draft.saveKeyImages(items)} />
      </Card>

      <Card>
        <Space wrap>
          <Button
            icon={<EyeOutlined />}
            loading={previewing}
            onClick={() => void preview()}
            disabled={draft.state === 'conflict'}
          >
            {t('reports.preview.button')}
          </Button>
          <Tooltip title={t('reports.refill.tooltip')}>
            <Button
              icon={<SyncOutlined />}
              loading={refill.isPending}
              onClick={() => void refillSections()}
              disabled={draft.state === 'conflict'}
            >
              {t('reports.refill.button')}
            </Button>
          </Tooltip>
          <Tooltip
            title={
              signable
                ? undefined
                : missingImages > 0
                  ? t('reports.sign.imagesMissing')
                  : t('reports.sign.needsImpression')
            }
          >
            <Button
              type="primary"
              icon={<SafetyCertificateOutlined />}
              disabled={!signable || draft.state === 'conflict'}
              loading={finalize.isPending}
              onClick={() => void sign()}
            >
              {t('reports.sign.button')}
            </Button>
          </Tooltip>
          {report.author.id === userId && (
            <Popconfirm
              title={t('reports.discard.confirm')}
              okText={t('reports.discard.button')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
              onConfirm={() =>
                remove.mutate(report, {
                  onSuccess: () => {
                    void message.success(t('reports.discard.done'));
                    onDeleted();
                  },
                  onError: (e) => void message.error(errorMessage(e)),
                })
              }
            >
              <Button danger icon={<DeleteOutlined />} loading={remove.isPending}>
                {t('reports.discard.button')}
              </Button>
            </Popconfirm>
          )}
        </Space>
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
          {t('reports.sign.hint')}
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}

// ---------- read-only (FINAL, or a draft for users who cannot edit it) ----------

function ReportReadView({
  report,
  amendable,
  onAmended,
}: {
  report: ReportDto;
  amendable: boolean;
  onAmended: (report: ReportDto) => void;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const amend = useAmendReport();
  const [busy, setBusy] = useState<'download' | 'open' | 'preview' | null>(null);
  const final = report.status === 'FINAL';

  const withPdf = async (action: 'download' | 'open') => {
    setBusy(action);
    try {
      const url = await finalPdfUrl(report);
      if (action === 'download') downloadUrl(url, reportFileName(report, false));
      else if (!window.open(url, '_blank', 'noopener'))
        downloadUrl(url, reportFileName(report, false));
    } catch (e) {
      void message.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const preview = async () => {
    setBusy('preview');
    try {
      const shown = await openPreviewPdf(report);
      if (shown === 'download') void message.info(t('reports.preview.downloaded'));
    } catch (e) {
      void message.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={t(final ? 'reports.finalTitle' : 'reports.draftTitle', { version: report.version })}
        extra={
          final ? (
            <Space wrap>
              <Button
                icon={<DownloadOutlined />}
                type="primary"
                loading={busy === 'download'}
                onClick={() => void withPdf('download')}
              >
                {t('reports.pdf.download')}
              </Button>
              <Button
                icon={<FilePdfOutlined />}
                loading={busy === 'open'}
                onClick={() => void withPdf('open')}
              >
                {t('reports.pdf.open')}
              </Button>
            </Space>
          ) : (
            <Button
              icon={<EyeOutlined />}
              loading={busy === 'preview'}
              onClick={() => void preview()}
            >
              {t('reports.preview.button')}
            </Button>
          )
        }
      >
        {!final && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title={t('reports.readOnlyDraft')}
          />
        )}
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2 }}
          style={{ marginBottom: 16 }}
          items={[
            {
              key: 'template',
              label: t('reports.template'),
              children: t(`reports.templates.${report.template}`),
            },
            {
              key: 'language',
              label: t('reports.language'),
              children: t(`reports.languages.${report.language}`),
            },
            { key: 'author', label: t('reports.author'), children: report.author.fullName },
            {
              key: 'signed',
              label: t('reports.signedBy'),
              children: report.signedBy
                ? `${report.signedBy.fullName} · ${formatDateTime(report.signedAt, i18n.language)}`
                : t('common.none'),
            },
            ...(report.amendsReportId
              ? [
                  {
                    key: 'amends',
                    label: t('reports.amends'),
                    children: t('reports.versionShort', { version: report.version - 1 }),
                  },
                ]
              : []),
          ]}
        />
        {SECTION_FIELDS.map((field) => (
          <section key={field} className="report-section">
            <Typography.Title level={5}>{t(`reports.sections.${field}`)}</Typography.Title>
            <Typography.Paragraph className="report-section__text">
              {report[field] || t('common.none')}
            </Typography.Paragraph>
          </section>
        ))}
      </Card>

      <Card title={t('reports.keyImages.title')}>
        <KeyImagesView report={report} />
      </Card>

      {amendable && (
        <Card>
          <Space orientation="vertical">
            <Typography.Text type="secondary">{t('reports.amend.hint')}</Typography.Text>
            <Button
              icon={<FileAddOutlined />}
              loading={amend.isPending}
              onClick={() =>
                amend.mutate(report, {
                  onSuccess: (draft) => {
                    void message.success(t('reports.amend.done', { version: draft.version }));
                    onAmended(draft);
                  },
                  onError: (e) => void message.error(errorMessage(e)),
                })
              }
            >
              {t('reports.amend.button')}
            </Button>
          </Space>
        </Card>
      )}
    </Space>
  );
}

// ---------- versions ----------

function VersionHistory({
  reports,
  selectedId,
  onSelect,
}: {
  reports: readonly ReportSummaryDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Card title={t('reports.versions')} size="small">
      {reports.length === 0 ? (
        <Typography.Text type="secondary">{t('reports.noVersions')}</Typography.Text>
      ) : (
        <ol className="report-versions" aria-label={t('reports.versions')}>
          {reports.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={`report-versions__item${r.id === selectedId ? ' report-versions__item--selected' : ''}`}
                aria-pressed={r.id === selectedId}
                onClick={() => onSelect(r.id)}
              >
                <ReportStatusTag report={r} />
                <span className="report-versions__meta">
                  {r.status === 'FINAL' && r.signedBy
                    ? t('reports.signedLine', {
                        name: r.signedBy.fullName,
                        time: formatDateTime(r.signedAt, i18n.language),
                      })
                    : t('reports.updatedLine', {
                        time: formatDateTime(r.updatedAt, i18n.language),
                      })}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
