import { useQuery } from '@tanstack/react-query';
import { Button, Result, Skeleton } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { studiesApi } from '@/api/endpoints';
import { toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import { isVolumeInput } from '@/api/types';
import { ProblemAlert } from '@/shared/components/ProblemAlert';
import { ImageStudyView } from './ImageStudyView';
import { useRefreshBudget } from './lib/useRefreshBudget';
import { VolumeStudyView } from './volume/VolumeStudyView';

/** `/studies/:studyId`: 2D studies keep the canvas viewer, CT volumes get MPR | 3D. */
export default function ViewerPage() {
  const { studyId = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const refreshBudget = useRefreshBudget();

  const study = useQuery({
    queryKey: queryKeys.studies.detail(studyId),
    queryFn: () => studiesApi.get(studyId),
    enabled: !!studyId,
  });

  if (study.isError && toAppError(study.error).status === 404) {
    return (
      <Result
        status="404"
        title={t('viewer.studyNotFound')}
        extra={<Button onClick={() => void navigate('/cases')}>{t('nav.cases')}</Button>}
      />
    );
  }

  if (study.isError && !study.data) {
    return (
      <div className="page">
        <ProblemAlert error={study.error} onRetry={() => void study.refetch()} />
      </div>
    );
  }

  if (!study.data) {
    return (
      <div className="viewer-page viewer-page--loading" data-testid="viewer-loading">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  const View = isVolumeInput(study.data.inputType) ? VolumeStudyView : ImageStudyView;
  return <View study={study.data} refetchStudy={study.refetch} refreshBudget={refreshBudget} />;
}
