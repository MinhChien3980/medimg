import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AnnotationDto,
  CreateAnnotationRequest,
  StudyDto,
  UpdateAnnotationRequest,
  VolumeGeometry,
} from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { VolumeBackendsContext } from '@/features/viewer/volume/backends';
import ViewerPage from '@/features/viewer/ViewerPage';
import { createFakeBackends, type FakeMprEngine } from '@/test/fakeVolumeBackends';
import {
  annotation,
  ctStudy,
  doctor,
  researcher,
  segModel,
  stackStudy,
  tokens,
} from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';

const AXIAL = { viewPlaneNormal: [0, 0, -1], viewUp: [0, -1, 0] } as const;

const ellipseGeometry: VolumeGeometry = {
  points: [
    [-60, 30, -410],
    [-60, 10, -410],
    [-70, 20, -410],
    [-50, 20, -410],
  ],
  viewPlaneNormal: [...AXIAL.viewPlaneNormal],
  viewUp: [...AXIAL.viewUp],
  sliceIndex: 42,
};

function volumeAnnotation(s: StudyDto, overrides: Partial<AnnotationDto> = {}): AnnotationDto {
  return annotation({
    id: 'v1',
    studyId: s.id,
    seriesId: s.series[0]?.id ?? '',
    kind: 'ELLIPSE_ROI',
    geometry: ellipseGeometry,
    label: 'Liver lesion',
    measurement: { areaMm2: 314.16, meanHu: 54.4, stdHu: 12 },
    ...overrides,
  });
}

function serve(s: StudyDto, annotations: AnnotationDto[]) {
  const rec = {
    created: [] as CreateAnnotationRequest[],
    updated: [] as Array<{ id: string; body: UpdateAnnotationRequest }>,
    deleted: [] as string[],
  };
  let list = annotations;
  server.use(
    mock.get(`${API}/studies/${s.id}`, () => HttpResponse.json(s)),
    mock.get(`${API}/studies/${s.id}/predictions`, () => HttpResponse.json([])),
    mock.get(`${API}/models`, () => HttpResponse.json([segModel])),
    mock.get(`${API}/studies/${s.id}/annotations`, () => HttpResponse.json(list)),
    mock.post(`${API}/studies/${s.id}/annotations`, async ({ request }) => {
      const body = (await request.json()) as CreateAnnotationRequest;
      rec.created.push(body);
      const created = volumeAnnotation(s, {
        id: `new-${rec.created.length}`,
        kind: body.kind,
        geometry: body.geometry,
        label: null,
        measurement: body.measurement ?? null,
      });
      list = [...list, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    mock.put(`${API}/annotations/:id`, async ({ params, request }) => {
      const body = (await request.json()) as UpdateAnnotationRequest;
      rec.updated.push({ id: String(params.id), body });
      const base = list.find((a) => a.id === params.id);
      if (!base) return HttpResponse.json({ status: 404 }, { status: 404 });
      const saved = { ...base, ...body, version: body.version + 1 };
      list = list.map((a) => (a.id === saved.id ? saved : a));
      return HttpResponse.json(saved);
    }),
    mock.delete(`${API}/annotations/:id`, ({ params }) => {
      rec.deleted.push(String(params.id));
      list = list.filter((a) => a.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return rec;
}

async function open(s: StudyDto, user = doctor) {
  useAuthStore.getState().setSession(tokens('acc', 'ref', user));
  const fake = createFakeBackends();
  renderWithProviders(
    <VolumeBackendsContext.Provider value={fake.backends}>
      <ViewerPage />
    </VolumeBackendsContext.Provider>,
    { route: `/studies/${s.id}`, path: '/studies/:studyId' },
  );
  await waitFor(() => expect(fake.engines).toHaveLength(1));
  return fake.engines[0] as FakeMprEngine;
}

const drawnRect: VolumeGeometry = {
  points: [
    [-10, 5, -400],
    [10, 5, -400],
    [-10, -5, -400],
    [10, -5, -400],
  ],
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
  sliceIndex: 12,
};

describe('MPR annotations', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', doctor));
  });

  it('restores the saved measurements of the series in the engine, others’ locked', async () => {
    const theirs = volumeAnnotation(ctStudy, {
      id: 'v2',
      kind: 'LENGTH',
      author: { id: 'someone', fullName: 'Dr. Other' },
      geometry: {
        ...ellipseGeometry,
        points: [
          [0, 0, -400],
          [30, 40, -400],
        ],
      },
      label: null,
      measurement: { lengthMm: 50 },
    });
    const otherSeries = volumeAnnotation(ctStudy, { id: 'v3', seriesId: 'elsewhere' });
    const flat = annotation({ id: 'v4', studyId: ctStudy.id, seriesId: ctStudy.series[0]?.id });
    serve(ctStudy, [volumeAnnotation(ctStudy), theirs, otherSeries, flat]);
    const engine = await open(ctStudy);

    await waitFor(() => expect(engine.annotations).toHaveLength(2));
    expect(engine.annotations).toEqual([
      {
        uid: 'v1',
        kind: 'ELLIPSE_ROI',
        geometry: ellipseGeometry,
        label: 'Liver lesion',
        locked: false,
      },
      {
        uid: 'v2',
        kind: 'LENGTH',
        geometry: {
          ...ellipseGeometry,
          points: [
            [0, 0, -400],
            [30, 40, -400],
          ],
        },
        label: null,
        locked: true,
      },
    ]);
  });

  it('creates a measurement drawn in the engine, then updates it with its version', async () => {
    const rec = serve(ctStudy, []);
    const engine = await open(ctStudy);
    await waitFor(() => expect(engine.annotationSets.length).toBeGreaterThan(0));

    act(() =>
      engine.emitAnnotationChange({
        uid: 'cs-1',
        kind: 'RECTANGLE_ROI',
        geometry: drawnRect,
        measurement: { areaMm2: 200, meanHu: 41.5, stdHu: 9.8 },
      }),
    );
    await waitFor(() => expect(rec.created).toHaveLength(1));
    expect(rec.created[0]).toEqual({
      seriesId: ctStudy.series[0]?.id,
      kind: 'RECTANGLE_ROI',
      geometry: drawnRect,
      measurement: { areaMm2: 200, meanHu: 41.5, stdHu: 9.8 },
    });
    // The engine keeps its own uid for the saved annotation (no duplicate is added).
    await waitFor(() =>
      expect(engine.annotations.map((a) => [a.uid, a.locked])).toEqual([['cs-1', false]]),
    );

    const moved = { ...drawnRect, points: drawnRect.points.map(([x, y, z]) => [x + 5, y, z]) };
    act(() =>
      engine.emitAnnotationChange({
        uid: 'cs-1',
        kind: 'RECTANGLE_ROI',
        geometry: moved as VolumeGeometry,
        measurement: { areaMm2: 200, meanHu: 60, stdHu: 10 },
      }),
    );
    await waitFor(() => expect(rec.updated).toHaveLength(1));
    expect(rec.updated[0]).toEqual({
      id: 'new-1',
      body: {
        geometry: moved,
        label: null,
        note: null,
        measurement: { areaMm2: 200, meanHu: 60, stdHu: 10 },
        version: 0,
      },
    });
  });

  it('keeps no HU statistics for a volume that is not in Hounsfield units', async () => {
    const rec = serve(stackStudy, []);
    const engine = await open(stackStudy);
    await waitFor(() => expect(engine.annotationSets.length).toBeGreaterThan(0));
    act(() =>
      engine.emitAnnotationChange({
        uid: 'cs-1',
        kind: 'ELLIPSE_ROI',
        geometry: ellipseGeometry,
        measurement: { areaMm2: 80, meanHu: 120, stdHu: 3 },
      }),
    );
    await waitFor(() => expect(rec.created).toHaveLength(1));
    expect(rec.created[0]?.measurement).toEqual({ areaMm2: 80 });
  });

  it('jumps to the slice of a listed measurement, selects it and deletes it', async () => {
    const user = userEvent.setup();
    const rec = serve(ctStudy, [volumeAnnotation(ctStudy)]);
    const engine = await open(ctStudy);
    await user.click(await screen.findByRole('tab', { name: /Annotations/ }));

    expect(await screen.findByText(/314 mm² · mean 54 HU, SD 12/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Liver lesion on the MPR' }));
    await waitFor(() => expect(engine.jumps.at(-1)).toEqual([-60, 20, -410]));
    await waitFor(() => expect(engine.selections.at(-1)).toBe('v1'));
    expect(screen.getByText('Centre (LPS, mm): -60.0, 20.0, -410.0')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete Liver lesion' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(rec.deleted).toEqual(['v1']));
    await waitFor(() => expect(engine.annotations).toEqual([]));
  });

  it('selects in the list what is clicked in a view', async () => {
    serve(ctStudy, [volumeAnnotation(ctStudy)]);
    const engine = await open(ctStudy);
    await waitFor(() => expect(engine.annotations).toHaveLength(1));

    act(() => engine.emitAnnotationSelect('v1'));
    const row = await screen.findByRole('button', { name: /^Liver lesion/ });
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tab', { name: /Annotations/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('offers the measurement tools to a doctor, not to a researcher', async () => {
    const user = userEvent.setup();
    serve(ctStudy, []);
    const engine = await open(ctStudy);
    const ellipse = await screen.findByRole('button', { name: /Ellipse ROI/ });
    await user.click(ellipse);
    await waitFor(() => expect(engine.tools.at(-1)).toBe('ellipseRoi'));
    expect(ellipse).toHaveAttribute('aria-pressed', 'true');
    await user.click(ellipse);
    await waitFor(() => expect(engine.tools.at(-1)).toBe('crosshairs'));
  });

  it('gives a researcher no measurement tools and no "Add to report"', async () => {
    serve(ctStudy, []);
    await open(ctStudy, researcher);
    await screen.findByRole('img', { name: 'Axial view' });
    expect(screen.queryByRole('button', { name: /Ellipse ROI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add to report/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open report' })).toBeInTheDocument();
  });

  it('captures the active view for the report', async () => {
    const user = userEvent.setup();
    serve(ctStudy, []);
    const engine = await open(ctStudy);
    await waitFor(() => expect(engine.loads).toHaveLength(1));

    await user.click(screen.getByRole('img', { name: 'Coronal view' }));
    await user.click(await screen.findByRole('button', { name: /Add to report/ }));
    await waitFor(() => expect(engine.captures).toEqual(['coronal']));
    const dialog = await screen.findByRole('dialog', { name: 'Add a key image to the report' });
    expect(within(dialog).getByLabelText('Caption')).toHaveValue('CT ABDOMEN – Coronal view');
  });
});
