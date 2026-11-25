import { ArrowLeftOutlined, CloudUploadOutlined, PictureOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Descriptions, Empty, Result, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { patientsApi, studiesApi } from '@/api/endpoints';
import { toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import { isVolumeInput, type PredictionDto, type StudyDto } from '@/api/types';
import { findingValue, isSegmentationResult, sortFindings } from '@/features/ai/findings';
import { PredictionStatusTag } from '@/features/ai/PredictionStatusTag';
import { useCan } from '@/features/auth/permissions';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { formatDateTime } from '@/shared/lib/format';

export default function CaseDetailPage() {
  const { caseId = '' } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const uploadPath = `/upload?caseId=${caseId}`;

  const patient = useQuery({
    queryKey: queryKeys.patients.detail(caseId),
    queryFn: () => patientsApi.get(caseId),
    enabled: !!caseId,
  });
  const studies = useQuery({
    queryKey: queryKeys.patients.studies(caseId),
    queryFn: () => patientsApi.studies(caseId),
    enabled: !!caseId,
  });

  if (patient.isError && toAppError(patient.error).status === 404) {
    return (
      <Result
        status="404"
        title={t('caseDetail.notFound')}
        extra={
          <Button onClick={() => void navigate('/cases')}>{t('caseDetail.backToList')}</Button>
        }
      />
    );
  }

  const p = patient.data;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <Link to="/cases" className="back-link">
            <ArrowLeftOutlined /> {t('caseDetail.backToList')}
          </Link>
          <Typography.Title level={3} style={{ margin: '4px 0 0' }}>
            {p?.code ?? <Skeleton.Input active size="small" />}
          </Typography.Title>
        </div>
        {can('upload') && (
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            onClick={() => void navigate(uploadPath)}
          >
            {t('caseDetail.upload')}
          </Button>
        )}
      </div>

      {patient.isError && <ProblemAlert error={patient.error} style={{ marginBottom: 16 }} />}

      <Card title={t('caseDetail.info')} size="small" style={{ marginBottom: 16 }}>
        {p ? (
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 4 }}
            items={[
              { key: 'code', label: t('cases.columns.code'), children: p.code },
              {
                key: 'birthYear',
                label: t('cases.columns.birthYear'),
                children: p.birthYear ?? t('common.none'),
              },
              {
                key: 'sex',
                label: t('cases.columns.sex'),
                children: p.sex ? t(`cases.sex.${p.sex}`) : t('common.none'),
              },
              {
                key: 'createdAt',
                label: t('cases.columns.createdAt'),
                children: formatDateTime(p.createdAt, i18n.language),
              },
              {
                key: 'note',
                label: t('cases.columns.note'),
                span: 'filled',
                children: p.note || t('common.none'),
              },
            ]}
          />
        ) : (
          <Skeleton active paragraph={{ rows: 2 }} />
        )}
      </Card>

      <Typography.Title level={4}>{t('caseDetail.studies')}</Typography.Title>
      {studies.isError && (
        <ProblemAlert
          error={studies.error}
          onRetry={() => void studies.refetch()}
          style={{ marginBottom: 16 }}
        />
      )}
      {studies.isPending ? (
        <Skeleton active />
      ) : studies.data && studies.data.length > 0 ? (
        <div className="study-list">
          {studies.data.map((s) => (
            <StudyCard key={s.id} study={s} onThumbError={() => void studies.refetch()} />
          ))}
        </div>
      ) : (
        <Empty description={t('caseDetail.noStudies')}>
          {can('upload') && (
            <Button icon={<CloudUploadOutlined />} onClick={() => void navigate(uploadPath)}>
              {t('caseDetail.upload')}
            </Button>
          )}
        </Empty>
      )}
    </div>
  );
}

function StudyThumbnail({ study, onError }: { study: StudyDto; onError: () => void }) {
  const url = study.series[0]?.thumbnailUrl;
  // Retry once per URL: presigned URLs expire after 15 min, a refetch returns fresh ones.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) {
    return (
      <div className="study-card__thumb study-card__thumb--empty">
        <PictureOutlined />
      </div>
    );
  }
  return (
    <img
      className="study-card__thumb"
      src={url}
      alt={`${study.modality} ${study.bodyPart}`}
      onError={() => {
        setFailedUrl(url);
        onError();
      }}
    />
  );
}

function StudyCard({ study, onThumbError }: { study: StudyDto; onThumbError: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const viewerPath = `/studies/${study.id}`;
  const dims = study.series[0]?.dims?.join('×');

  return (
    <Card size="small" className="study-card">
      <div className="study-card__body">
        <Link to={viewerPath} className="study-card__media" aria-label={t('caseDetail.openViewer')}>
          <StudyThumbnail study={study} onError={onThumbError} />
        </Link>
        <div className="study-card__meta">
          <div className="study-card__title">
            <Tag color="blue">{study.modality}</Tag>
            <Tag>{study.bodyPart}</Tag>
            {isVolumeInput(study.inputType) && (
              <Tag color="geekblue">{t('caseDetail.volume', { dims: dims ?? '' })}</Tag>
            )}
            <Typography.Text type="secondary">
              {formatDateTime(study.createdAt, i18n.language)}
            </Typography.Text>
          </div>
          <Button size="small" onClick={() => void navigate(viewerPath)}>
            {t('caseDetail.openViewer')}
          </Button>
          <Typography.Text strong style={{ display: 'block', margin: '12px 0 4px' }}>
            {t('caseDetail.aiHistory')}
          </Typography.Text>
          <StudyJobsTable studyId={study.id} />
        </div>
      </div>
    </Card>
  );
}

function StudyJobsTable({ studyId }: { studyId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const jobs = useQuery({
    queryKey: queryKeys.studies.predictions(studyId),
    queryFn: () => studiesApi.predictions(studyId),
  });

  const runPath = (jobId: string) => `/studies/${studyId}?job=${jobId}`;

  const columns: ColumnsType<PredictionDto> = [
    {
      title: t('caseDetail.queuedAt'),
      dataIndex: 'queuedAt',
      render: (v: string, r) => (
        <Link to={runPath(r.jobId)} onClick={(e) => e.stopPropagation()}>
          {formatDateTime(v, i18n.language)}
        </Link>
      ),
    },
    {
      title: t('caseDetail.model'),
      key: 'model',
      render: (_, r) => `${r.model.code}@${r.model.version}`,
    },
    {
      title: t('caseDetail.status'),
      dataIndex: 'status',
      render: (s: PredictionDto['status']) => <PredictionStatusTag status={s} />,
    },
    {
      title: t('caseDetail.topFinding'),
      key: 'top',
      render: (_, r) => {
        const top = sortFindings(r.findings)[0];
        if (isSegmentationResult(r)) return t('ai.structures', { count: r.findings.length });
        return top ? `${top.label} · ${findingValue(top, i18n.language)}` : t('common.none');
      },
    },
    {
      title: t('caseDetail.duration'),
      dataIndex: 'inferenceMs',
      align: 'right',
      render: (v: number | null) => (v != null ? `${v} ms` : t('common.none')),
    },
  ];

  if (jobs.isError) return <ProblemAlert error={jobs.error} />;

  return (
    <Table<PredictionDto>
      size="small"
      rowKey="jobId"
      columns={columns}
      dataSource={jobs.data ?? []}
      loading={jobs.isPending}
      pagination={false}
      locale={{ emptyText: t('caseDetail.noJobs') }}
      onRow={(r) => ({
        onClick: () => void navigate(runPath(r.jobId)),
        style: { cursor: 'pointer' },
      })}
    />
  );
}
