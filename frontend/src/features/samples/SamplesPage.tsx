import { CheckCircleOutlined, EyeOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, Skeleton, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { samplesApi } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import { isVolumeInput, type SampleCaseDto, type SampleStudyDto } from '@/api/types';
import { useCan } from '@/features/auth/permissions';
import { PresignedThumbnail } from '@/shared/components/PresignedThumbnail';
import { ProblemAlert } from '@/shared/components/ProblemAlert';

/** `/samples`: the sample cases every role can open without uploading anything. */
export default function SamplesPage() {
  const { t } = useTranslation();
  const can = useCan();
  const samples = useQuery({ queryKey: queryKeys.samples.all, queryFn: samplesApi.list });

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {t('samples.title')}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
            {t('samples.intro')}
          </Typography.Paragraph>
        </div>
      </div>

      {samples.isError && (
        <ProblemAlert
          error={samples.error}
          onRetry={() => void samples.refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      {samples.isPending ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : samples.data && samples.data.length > 0 ? (
        <ul className="sample-grid" aria-label={t('samples.title')}>
          {samples.data.map((sample) => (
            <li key={sample.patientId}>
              <SampleCard sample={sample} onThumbnailError={() => void samples.refetch()} />
            </li>
          ))}
        </ul>
      ) : (
        !samples.isError && (
          <Empty description={t('samples.empty')}>
            {can('manageSamples') && (
              <Typography.Text type="secondary">{t('samples.emptyAdmin')}</Typography.Text>
            )}
          </Empty>
        )
      )}
    </div>
  );
}

/** Viewer path of a study, on its latest run when that run has a result to show. */
function viewerPath(study: SampleStudyDto): string {
  const run = study.latestPrediction;
  return run?.status === 'DONE'
    ? `/studies/${study.studyId}?job=${run.jobId}`
    : `/studies/${study.studyId}`;
}

function ResultBadge({ studies }: { studies: SampleStudyDto[] }) {
  const { t } = useTranslation();
  const done = studies.filter((s) => s.latestPrediction?.status === 'DONE');
  if (done.length === 0) return null;
  // Every model that accepts a volume segments it; 2D models classify.
  const segmented = done.some((s) => isVolumeInput(s.inputType));
  return (
    <Tag color="success" icon={<CheckCircleOutlined />} className="sample-card__badge">
      {t(segmented ? 'samples.segmented' : 'samples.analysed')}
    </Tag>
  );
}

function SampleCard({
  sample,
  onThumbnailError,
}: {
  sample: SampleCaseDto;
  onThumbnailError: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const headingId = `sample-${sample.patientId}`;
  const cover = sample.studies[0];

  return (
    <Card
      className="sample-card"
      aria-labelledby={headingId}
      cover={
        <div className="sample-card__cover">
          <PresignedThumbnail
            url={cover?.thumbnailUrl}
            alt={t('samples.thumbnailAlt', { title: sample.title })}
            className="sample-card__thumb"
            onError={onThumbnailError}
          />
          <ResultBadge studies={sample.studies} />
        </div>
      }
    >
      <Typography.Title level={4} id={headingId} className="sample-card__title">
        {sample.title}
      </Typography.Title>
      <div className="sample-card__tags">
        {sample.studies.map((s) => (
          <Tag key={s.studyId} color="blue">
            {s.modality} · {t(`caseDetail.inputTypes.${s.inputType}`)}
          </Tag>
        ))}
      </div>
      {sample.description && (
        <Typography.Paragraph className="sample-card__description" ellipsis={{ rows: 3 }}>
          {sample.description}
        </Typography.Paragraph>
      )}
      <Typography.Paragraph type="secondary" className="sample-card__source">
        {t('samples.source')}: {sample.source}
      </Typography.Paragraph>

      <div className="sample-card__actions">
        {sample.studies.length === 0 && (
          <Typography.Text type="secondary">{t('samples.noStudies')}</Typography.Text>
        )}
        {sample.studies.map((s) => (
          <Button
            key={s.studyId}
            type="primary"
            icon={<EyeOutlined />}
            aria-label={t('samples.openStudy', { title: sample.title, modality: s.modality })}
            onClick={() => void navigate(viewerPath(s))}
          >
            {t('samples.open')}
          </Button>
        ))}
        <Link to={`/cases/${sample.patientId}`} className="sample-card__case">
          <FolderOpenOutlined /> {t('samples.caseLink', { code: sample.code })}
        </Link>
      </div>
    </Card>
  );
}
