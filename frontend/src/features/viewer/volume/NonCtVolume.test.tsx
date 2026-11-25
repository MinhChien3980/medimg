/**
 * Volumes that are not CT in Hounsfield units (an image stack, an MR): no CT window presets, a
 * default window over the data range, no 3D tab without meshes, and an assumed spacing flagged.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StudyDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { createFakeBackends, type FakeMprEngine } from '@/test/fakeVolumeBackends';
import { ctStudy, stackStudy, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import ViewerPage from '../ViewerPage';
import { VolumeBackendsContext } from './backends';

function serve(s: StudyDto) {
  server.use(
    mock.get(`${API}/studies/${s.id}`, () => HttpResponse.json(s)),
    mock.get(`${API}/studies/${s.id}/predictions`, () => HttpResponse.json([])),
    mock.get(`${API}/models`, () => HttpResponse.json([])),
  );
}

async function renderVolume(s: StudyDto, range: [number, number]) {
  const fake = createFakeBackends({ range });
  renderWithProviders(
    <VolumeBackendsContext.Provider value={fake.backends}>
      <ViewerPage />
    </VolumeBackendsContext.Provider>,
    { route: `/studies/${s.id}`, path: '/studies/:studyId' },
  );
  await waitFor(() => expect(fake.engines[0]?.loads).toHaveLength(1));
  return fake.engines[0] as FakeMprEngine;
}

describe('non-CT volume', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
  });

  it('windows an image stack over its data range, without CT presets, and resets to it', async () => {
    const user = userEvent.setup();
    serve(stackStudy);
    const engine = await renderVolume(stackStudy, [0, 255]);

    await waitFor(() =>
      expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 256 / L 128'),
    );
    // The first window the engine gets is the data one, never the CT soft-tissue default.
    expect(engine.windows).toEqual([{ width: 256, center: 128 }]);
    expect(screen.queryByRole('radio', { name: 'Soft tissue' })).not.toBeInTheDocument();
    expect(screen.queryByText('Lung')).not.toBeInTheDocument();

    act(() => engine.events.onWindowChange?.({ width: 80, center: 40 }));
    expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 80 / L 40');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 256 / L 128');
    expect(engine.windows.at(-1)).toEqual({ width: 256, center: 128 });
  });

  it('has no 3D tab, flags the assumed spacing and says no model takes it', async () => {
    serve(stackStudy);
    await renderVolume(stackStudy, [0, 255]);

    expect(screen.getByRole('tab', { name: 'MPR' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '3D' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Slice spacing assumed to be 1 mm – measurements are not accurate.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/1\.00 × 1\.00 × 1\.00 mm \(assumed\)/)).toBeInTheDocument();
    expect(await screen.findByText('No AI model for this image type')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run/ })).not.toBeInTheDocument();
  });

  it('treats an MR volume the same way (no Hounsfield units)', async () => {
    const mr: StudyDto = {
      ...ctStudy,
      modality: 'MR',
      series: ctStudy.series.map((s) => ({ ...s, modality: 'MR' })),
    };
    serve(mr);
    await renderVolume(mr, [0, 1799]);

    await waitFor(() =>
      expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 1800 / L 900'),
    );
    expect(screen.queryByText('Lung')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '3D' })).not.toBeInTheDocument();
    // A measured spacing is not flagged.
    expect(screen.queryByText(/Slice spacing assumed/)).not.toBeInTheDocument();
  });

  it('keeps the CT presets and the 3D tab for a CT, starting on soft tissue', async () => {
    serve(ctStudy);
    const engine = await renderVolume(ctStudy, [-1024, 3071]);

    expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 400 / L 40');
    expect(engine.windows[0]).toEqual({ width: 400, center: 40 });
    expect(screen.getByText('Lung')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '3D' })).toBeInTheDocument();
  });
});
