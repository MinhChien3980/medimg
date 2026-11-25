import { screen, waitFor } from '@testing-library/react';
import { http as mock, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { InputType, StudyDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { createFakeBackends } from '@/test/fakeVolumeBackends';
import { ctStudy, model, segModel, study, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import { VolumeBackendsContext } from './volume/backends';
import ViewerPage from './ViewerPage';

function serve(s: StudyDto) {
  const models: string[] = [];
  server.use(
    mock.get(`${API}/studies/${s.id}`, () => HttpResponse.json(s)),
    mock.get(`${API}/studies/${s.id}/predictions`, () => HttpResponse.json([])),
    mock.get(`${API}/models`, ({ request }) => {
      const inputType = new URL(request.url).searchParams.get('inputType') ?? '';
      models.push(inputType);
      return HttpResponse.json(inputType === 'IMAGE_2D' ? [model] : [segModel]);
    }),
  );
  return models;
}

function renderViewer(s: StudyDto) {
  const fake = createFakeBackends();
  renderWithProviders(
    <VolumeBackendsContext.Provider value={fake.backends}>
      <ViewerPage />
    </VolumeBackendsContext.Provider>,
    { route: `/studies/${s.id}`, path: '/studies/:studyId' },
  );
  return fake;
}

describe('ViewerPage routing by input type', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
  });

  it('keeps the 2D canvas viewer for an IMAGE_2D study', async () => {
    const models = serve(study);
    const fake = renderViewer(study);

    expect(await screen.findByRole('img', { name: 'CR CHEST' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'MPR' })).not.toBeInTheDocument();
    expect(fake.engines).toHaveLength(0);
    await screen.findByRole('button', { name: /Run AI/ });
    expect(models).toEqual(['IMAGE_2D']);
  });

  it.each<InputType>(['NIFTI', 'DICOM_SERIES'])(
    'opens MPR | 3D tabs for a %s volume and lists models for that input type',
    async (inputType) => {
      const volume: StudyDto = { ...ctStudy, inputType };
      const models = serve(volume);
      const fake = renderViewer(volume);

      expect(await screen.findByRole('tab', { name: 'MPR' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: '3D' })).toBeInTheDocument();
      expect(await screen.findByRole('img', { name: 'Axial view' })).toBeInTheDocument();
      await screen.findByRole('button', { name: /Run segmentation/ });
      await waitFor(() => expect(fake.engines[0]?.loads).toEqual([ctStudy.series[0]?.volumeUrl]));
      expect(models).toContain(inputType);
    },
  );
});
