import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelDto, PredictionDto } from '@/api/types';
import { queryKeys } from '@/api/queryKeys';
import { useAuthStore } from '@/features/auth/authStore';
import { createFakeBackends, type FakeMprEngine } from '@/test/fakeVolumeBackends';
import { ctStudy, SEG_JOB_ID, SEG_LABELS, segModel, segPrediction, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import ViewerPage from '../ViewerPage';
import { VolumeBackendsContext } from './backends';

const VOLUME_URL = ctStudy.series[0]?.volumeUrl ?? '';

function serve({
  models = [segModel],
  prediction = segPrediction,
}: { models?: ModelDto[]; prediction?: PredictionDto } = {}) {
  server.use(
    mock.get(`${API}/studies/${ctStudy.id}`, () => HttpResponse.json(ctStudy)),
    mock.get(`${API}/studies/${ctStudy.id}/predictions`, () => HttpResponse.json([prediction])),
    mock.get(`${API}/predictions/${SEG_JOB_ID}`, () => HttpResponse.json(prediction)),
    mock.get(`${API}/models`, () => HttpResponse.json(models)),
  );
}

async function renderVolumeViewer() {
  const fake = createFakeBackends();
  const view = renderWithProviders(
    <VolumeBackendsContext.Provider value={fake.backends}>
      <ViewerPage />
    </VolumeBackendsContext.Provider>,
    { route: `/studies/${ctStudy.id}`, path: '/studies/:studyId' },
  );
  await waitFor(() => expect(fake.engines).toHaveLength(1));
  const engine = fake.engines[0] as FakeMprEngine;
  await waitFor(() => expect(engine.labelmaps.length).toBeGreaterThan(0));
  return { ...view, engine, fake };
}

/** Labelmaps actually loaded (`null` only clears, e.g. while the run is still loading). */
const loadedLabelmaps = (engine: FakeMprEngine) => engine.labelmaps.filter((l) => l !== null);

const RIGHT_KEY = { key: 'ArrowRight', keyCode: 39, which: 39 };

const lastStyle = (engine: FakeMprEngine) => engine.styles[engine.styles.length - 1];

describe('VolumeStudyView', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
  });

  it('loads the volume, then overlays the labelmap with colours in model label order', async () => {
    serve();
    const { engine } = await renderVolumeViewer();

    expect(engine.loads).toEqual([VOLUME_URL]);
    await waitFor(() => expect(loadedLabelmaps(engine)).toHaveLength(1));
    const labelmap = loadedLabelmaps(engine)[0];
    expect(labelmap?.url).toBe(segPrediction.artifacts?.segmentation);
    const lut = labelmap?.colorLut ?? [];
    expect(lut).toHaveLength(SEG_LABELS.length + 1);
    // Voxel value = index in segModel.labels + 1, whatever the order of `meshes[]`.
    expect(lut[1]).toEqual([0xdc, 0x5a, 0x3c, 255]); // liver
    expect(lut[2]).toEqual([0x9e, 0x4f, 0xc0, 255]); // spleen
    expect(lut[3]).toEqual([0xb4, 0xa0, 0x3c, 255]); // kidney_left
    expect(lut[4]?.[3]).toBe(0);
    expect(labelmap?.hidden).toEqual([]);
  });

  it('applies W/L presets, the tool choice and the overlay opacity', async () => {
    const user = userEvent.setup();
    serve();
    const { engine } = await renderVolumeViewer();

    expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 400 / L 40');
    await user.click(screen.getByText('Lung'));
    expect(engine.windows.at(-1)).toEqual({ width: 1500, center: -600 });
    expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 1500 / L -600');
    await user.click(screen.getByText('Bone'));
    expect(engine.windows.at(-1)).toEqual({ width: 1800, center: 400 });

    // Dragging W/L in the engine updates the readout and leaves the presets.
    act(() => engine.events.onWindowChange?.({ width: 321, center: 12 }));
    expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 321 / L 12');
    expect(screen.getByRole('radio', { name: 'Bone' })).not.toBeChecked();

    await user.click(screen.getByText('Pan'));
    expect(engine.tools.at(-1)).toBe('pan');

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(engine.resets).toBe(1);
    expect(screen.getByTestId('mpr-window')).toHaveTextContent('W 400 / L 40');

    const opacity = screen.getByRole('slider', { name: 'Segmentation opacity' });
    fireEvent.keyDown(opacity, RIGHT_KEY);
    expect(engine.opacities.at(-1)).toBeCloseTo(0.55);
  });

  it('scrolls a view with the keyboard', async () => {
    serve();
    const { engine } = await renderVolumeViewer();
    const axial = screen.getByRole('img', { name: 'Axial view' });
    fireEvent.keyDown(axial, { key: 'ArrowDown' });
    fireEvent.keyDown(axial, { key: 'PageUp' });
    expect(engine.scrolls).toEqual([
      ['axial', 1],
      ['axial', -10],
    ]);
  });

  it('shares visibility and colour between the structure list, MPR and 3D', async () => {
    const user = userEvent.setup();
    serve();
    const { engine } = await renderVolumeViewer();

    await waitFor(() => expect(loadedLabelmaps(engine)).toHaveLength(1));
    const spleen = await screen.findByRole('button', { name: 'Show/hide Spleen' });
    expect(spleen).toHaveAttribute('aria-pressed', 'true');
    await user.click(spleen);
    expect(spleen).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(lastStyle(engine)?.hidden).toEqual([2]));
    expect(lastStyle(engine)?.colorLut[2]?.[3]).toBe(0);

    fireEvent.change(screen.getByLabelText('Colour of Liver'), { target: { value: '#00ff00' } });
    await waitFor(() => expect(lastStyle(engine)?.colorLut[1]).toEqual([0, 255, 0, 255]));
    // A restyle never reloads the labelmap.
    expect(loadedLabelmaps(engine)).toHaveLength(1);

    await user.click(screen.getByRole('tab', { name: '3D' }));
    const scene = await screen.findByTestId('fake-scene');
    expect(within(scene).getByText('mesh spleen')).toHaveAttribute('data-visible', 'false');
    expect(within(scene).getByText('mesh liver')).toHaveAttribute('data-color', '#00ff00');

    await user.click(screen.getByRole('button', { name: 'Hide all' }));
    expect(within(scene).getByText('mesh liver')).toHaveAttribute('data-visible', 'false');
    await waitFor(() => expect(lastStyle(engine)?.hidden).toEqual([1, 2, 3]));
  });

  it('clicking a structure in 3D switches to MPR and moves the crosshair to its centroid', async () => {
    const user = userEvent.setup();
    serve();
    const { engine } = await renderVolumeViewer();

    await user.click(screen.getByRole('tab', { name: '3D' }));
    await user.click(await screen.findByText('mesh kidney_left'));

    expect(screen.getByRole('tab', { name: 'MPR' })).toHaveAttribute('aria-selected', 'true');
    // LPS mm from the contract, passed through unchanged.
    expect(engine.jumps).toEqual([[71.0, 52.5, -455.75]]);
    expect(screen.getByTestId('mpr-crosshair')).toHaveTextContent(
      'Crosshair (LPS, mm): 71.0, 52.5, -455.8',
    );

    // The same structure again is a new jump; the list's locate button does the same.
    await user.click(screen.getByRole('button', { name: 'Show Liver on MPR' }));
    expect(engine.jumps.at(-1)).toEqual([-62.5, 18.25, -410.0]);
  });

  it('keeps one engine across tab switches and destroys it on unmount', async () => {
    const user = userEvent.setup();
    serve();
    const { engine, fake, unmount } = await renderVolumeViewer();

    await user.click(screen.getByRole('tab', { name: '3D' }));
    await screen.findByTestId('fake-scene');
    await user.click(screen.getByRole('tab', { name: 'MPR' }));
    await user.click(screen.getByRole('tab', { name: '3D' }));

    expect(fake.engines).toHaveLength(1);
    expect(engine.destroyed).toBe(0);
    expect(engine.loads).toHaveLength(1);

    unmount();
    expect(engine.destroyed).toBe(1);
  });

  it('does not reload the volume or the labelmap when presigned URLs are refreshed', async () => {
    serve();
    const { engine, queryClient } = await renderVolumeViewer();
    await waitFor(() => expect(loadedLabelmaps(engine)).toHaveLength(1));
    const styled = engine.styles.length;

    const resigned = (url: string | null | undefined) =>
      `${url?.split('?')[0]}?X-Amz-Signature=new`;
    act(() => {
      queryClient.setQueryData(queryKeys.studies.detail(ctStudy.id), {
        ...ctStudy,
        series: ctStudy.series.map((s) => ({ ...s, volumeUrl: resigned(s.volumeUrl) })),
      });
      queryClient.setQueryData(queryKeys.predictions.detail(SEG_JOB_ID), {
        ...segPrediction,
        artifacts: {
          ...segPrediction.artifacts,
          segmentation: resigned(segPrediction.artifacts?.segmentation),
        },
      });
    });

    // The new URLs re-render (restyle) but load nothing again.
    await waitFor(() => expect(engine.styles.length).toBeGreaterThan(styled));
    expect(engine.loads).toHaveLength(1);
    expect(loadedLabelmaps(engine)).toHaveLength(1);
  });

  it('refuses to overlay a labelmap whose label order is unknown', async () => {
    serve({ models: [{ ...segModel, version: '9.9.9' }] });
    const { engine } = await renderVolumeViewer();

    expect(
      await screen.findByText(
        'The segmentation cannot be overlaid on the MPR: the label order of model ct-totalseg is unknown.',
      ),
    ).toBeInTheDocument();
    expect(loadedLabelmaps(engine)).toEqual([]);
    // Structures are still listed (and flagged as 3D only).
    expect(screen.getByRole('button', { name: 'Show/hide Liver' })).toBeInTheDocument();
  });

  it('shows clipping sliders over the mesh bounds and passes the planes to the scene', async () => {
    const user = userEvent.setup();
    serve();
    await renderVolumeViewer();

    await user.click(screen.getByRole('tab', { name: '3D' }));
    const scene = await screen.findByTestId('fake-scene');
    expect(JSON.parse(scene.dataset.planes ?? 'null')).toEqual([]);

    const clipX = await screen.findByTestId('clip-x');
    expect(clipX).toHaveTextContent('-121 … 111 mm');
    const from = within(clipX).getByRole('slider', { name: 'Right → Left (x): from' });
    fireEvent.keyDown(from, RIGHT_KEY);
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('fake-scene').dataset.planes ?? '[]')).toEqual([
        { normal: [1, 0, 0], constant: 120 },
      ]),
    );

    await user.click(screen.getByRole('button', { name: /Clear clipping/ }));
    expect(JSON.parse(screen.getByTestId('fake-scene').dataset.planes ?? 'null')).toEqual([]);
  });

  it('refreshes the presigned URL after a failed volume load and retries with the new one', async () => {
    const user = userEvent.setup();
    let studyCalls = 0;
    server.use(
      mock.get(`${API}/studies/${ctStudy.id}`, () => {
        studyCalls += 1;
        const series = ctStudy.series.map((s) => ({
          ...s,
          volumeUrl: `${s.volumeUrl?.split('?')[0]}?X-Amz-Signature=${studyCalls}`,
        }));
        return HttpResponse.json({ ...ctStudy, series });
      }),
      mock.get(`${API}/studies/${ctStudy.id}/predictions`, () => HttpResponse.json([])),
      mock.get(`${API}/models`, () => HttpResponse.json([segModel])),
    );
    const fake = createFakeBackends({ failFirstLoad: true });
    renderWithProviders(
      <VolumeBackendsContext.Provider value={fake.backends}>
        <ViewerPage />
      </VolumeBackendsContext.Provider>,
      { route: `/studies/${ctStudy.id}`, path: '/studies/:studyId' },
    );

    expect(await screen.findByText('Could not load the CT volume')).toBeInTheDocument();
    await waitFor(() => expect(studyCalls).toBe(2));
    await user.click(screen.getByRole('button', { name: /Retry/ }));

    await waitFor(() => expect(screen.queryByText('Could not load the CT volume')).toBeNull());
    const engine = fake.engines[0] as FakeMprEngine;
    expect(fake.engines).toHaveLength(1);
    expect(engine.loads.map((u) => u.split('?')[1])).toEqual([
      'X-Amz-Signature=1',
      'X-Amz-Signature=2',
    ]);
  });

  it('asks to run a segmentation when the study has none', async () => {
    const user = userEvent.setup();
    server.use(
      mock.get(`${API}/studies/${ctStudy.id}`, () => HttpResponse.json(ctStudy)),
      mock.get(`${API}/studies/${ctStudy.id}/predictions`, () => HttpResponse.json([])),
      mock.get(`${API}/models`, () => HttpResponse.json([segModel])),
    );
    const fake = createFakeBackends();
    renderWithProviders(
      <VolumeBackendsContext.Provider value={fake.backends}>
        <ViewerPage />
      </VolumeBackendsContext.Provider>,
      { route: `/studies/${ctStudy.id}`, path: '/studies/:studyId' },
    );

    await user.click(await screen.findByRole('tab', { name: '3D' }));
    expect(
      await screen.findByText('Run organ segmentation to see the 3D structures'),
    ).toBeInTheDocument();
    await waitFor(() => expect(fake.engines[0]?.labelmaps).toEqual([null]));
  });
});
