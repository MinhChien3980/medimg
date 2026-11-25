import { ArrowLeftOutlined } from '@ant-design/icons';
import { Skeleton } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { SeriesDto, StudyDto } from '@/api/types';

interface SeriesSidebarProps {
  study: StudyDto | undefined;
  loading: boolean;
  selectedId: string | undefined;
  onSelect: (seriesId: string) => void;
  /** A thumbnail failed to load (its presigned URL may have expired). */
  onThumbnailError: () => void;
}

function seriesSize(s: SeriesDto): string {
  return s.dims ? s.dims.join('×') : `${s.cols}×${s.rows}`;
}

export function SeriesSidebar({
  study,
  loading,
  selectedId,
  onSelect,
  onThumbnailError,
}: SeriesSidebarProps) {
  const { t } = useTranslation();
  return (
    <aside className="viewer-page__series">
      {study && (
        <Link to={`/cases/${study.patientId}`} className="back-link back-link--dark">
          <ArrowLeftOutlined /> {t('viewer.backToCase')}
        </Link>
      )}
      <div className="viewer-page__series-title">{t('viewer.series')}</div>
      {loading && <Skeleton.Image active style={{ width: 112, height: 112 }} />}
      {study?.series.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`series-thumb${s.id === selectedId ? ' series-thumb--active' : ''}`}
          onClick={() => onSelect(s.id)}
          aria-pressed={s.id === selectedId}
        >
          <img src={s.thumbnailUrl} alt={s.modality} onError={onThumbnailError} />
          <span>
            {s.modality} · {seriesSize(s)}
          </span>
        </button>
      ))}
    </aside>
  );
}
