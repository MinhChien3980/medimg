import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnnotationDto,
  CreateAnnotationRequest,
  StudyDto,
  UpdateAnnotationRequest,
  UserDto,
} from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import ViewerPage from '@/features/viewer/ViewerPage';
import {
  annotation,
  dicomXrayStudy,
  doctor,
  model,
  researcher,
  study,
  technician,
  tokens,
} from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import { findModal } from '@/test/modal';

/** jsdom never decodes images: this one "loads" a 1000×800 picture. */
class LoadedImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = 'auto';
  naturalWidth = 1000;
  naturalHeight = 800;
  set src(_url: string) {
    queueMicrotask(() => this.onload?.());
  }
}

/** The viewer measures 800×600 CSS px. */
class FixedResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(): void {
    this.callback([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

// Fitted with 8 px padding: scale = min(784 / 1000, 584 / 800) = 0.73, centred.
const SCALE = 0.73;
const OFFSET = { x: (800 - 1000 * SCALE) / 2, y: (600 - 800 * SCALE) / 2 };
const at = (x: number, y: number) => ({
  clientX: OFFSET.x + x * SCALE,
  clientY: OFFSET.y + y * SCALE,
  pointerId: 1,
});

const other = annotation({
  id: 'ann-2',
  author: { id: 'someone', fullName: 'Dr. Other' },
  kind: 'LENGTH',
  geometry: { from: [500, 500], to: [600, 500] },
  label: null,
  measurement: { lengthPx: 100 },
});

interface Recorded {
  created: CreateAnnotationRequest[];
  updated: Array<{ id: string; body: UpdateAnnotationRequest }>;
  deleted: string[];
  lists: number;
}

function serve(s: StudyDto, annotations: AnnotationDto[], { conflict = false } = {}) {
  const rec: Recorded = { created: [], updated: [], deleted: [], lists: 0 };
  let list = annotations;
  server.use(
    mock.get(`${API}/studies/${s.id}`, () => HttpResponse.json(s)),
    mock.get(`${API}/studies/${s.id}/predictions`, () => HttpResponse.json([])),
    mock.get(`${API}/models`, () => HttpResponse.json([model])),
    mock.get(`${API}/studies/${s.id}/annotations`, () => {
      rec.lists += 1;
      return HttpResponse.json(list);
    }),
    mock.post(`${API}/studies/${s.id}/annotations`, async ({ request }) => {
      const body = (await request.json()) as CreateAnnotationRequest;
      rec.created.push(body);
      const created = annotation({
        id: `new-${rec.created.length}`,
        studyId: s.id,
        seriesId: body.seriesId,
        kind: body.kind,
        geometry: body.geometry,
        label: body.label ?? null,
        measurement: body.measurement ?? null,
      });
      list = [...list, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    mock.put(`${API}/annotations/:id`, async ({ params, request }) => {
      const body = (await request.json()) as UpdateAnnotationRequest;
      rec.updated.push({ id: String(params.id), body });
      if (conflict) {
        return HttpResponse.json({ status: 409, detail: 'Stale version' }, { status: 409 });
      }
      const base = list.find((a) => a.id === params.id) ?? annotation();
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

/**
 * Opens the viewer. `layer()` and `background()` look the elements up on every call: the layer
 * re-renders with the viewport, so a reference kept across awaits can point at a stale node.
 */
async function open(s: StudyDto, user: UserDto = doctor) {
  useAuthStore.getState().setSession(tokens('acc', 'ref', user));
  renderWithProviders(<ViewerPage />, { route: `/studies/${s.id}`, path: '/studies/:studyId' });
  await screen.findByTestId('annotation-layer');
  const layer = () => screen.getByTestId('annotation-layer');
  const background = () => layer().querySelector('.annotation-layer__background') as Element;
  return { layer, background };
}

/** Picks a drawing tool and waits until it is active, so the next pointer events draw with it. */
async function pickTool(user: ReturnType<typeof userEvent.setup>, name: string) {
  const button = screen.getByRole('button', { name });
  await user.click(button);
  await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
}

const openAnnotationsTab = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('tab', { name: /Annotations/ }));

describe('2D annotations in the viewer', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', LoadedImage);
    vi.stubGlobal('ResizeObserver', FixedResizeObserver);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws a rectangle, saved in image pixels with its area in px² (PNG: no spacing)', async () => {
    const user = userEvent.setup();
    const rec = serve(study, []);
    const { layer, background } = await open(study);

    expect(screen.getByTestId('pixel-spacing')).toHaveTextContent('Measured in px');
    await pickTool(user, 'Draw a rectangle');
    fireEvent.pointerDown(background(), { ...at(100, 100), button: 0 });
    fireEvent.pointerMove(layer(), at(300, 250));
    fireEvent.pointerUp(layer(), at(300, 250));

    await waitFor(() => expect(rec.created).toHaveLength(1));
    expect(rec.created[0]).toEqual({
      seriesId: study.series[0]?.id,
      kind: 'RECTANGLE',
      geometry: { x: 100, y: 100, width: 200, height: 150 },
      measurement: { areaPx2: 30000 },
    });
    await openAnnotationsTab(user);
    expect(await screen.findByRole('button', { name: /^Rectangle 1/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('measures a length in mm on a DICOM X-ray with pixel spacing', async () => {
    const user = userEvent.setup();
    const calibrated: StudyDto = {
      ...dicomXrayStudy,
      series: dicomXrayStudy.series.map((s) => ({ ...s, pixelSpacing: [0.2, 0.2] })),
    };
    const rec = serve(calibrated, []);
    const { layer, background } = await open(calibrated);

    expect(screen.getByTestId('pixel-spacing')).toHaveTextContent('0.200 × 0.200 mm');
    await pickTool(user, 'Measure a length');
    fireEvent.pointerDown(background(), { ...at(100, 100), button: 0 });
    fireEvent.pointerUp(layer(), at(400, 500));

    await waitFor(() => expect(rec.created).toHaveLength(1));
    expect(rec.created[0]?.geometry).toEqual({ from: [100, 100], to: [400, 500] });
    expect(rec.created[0]?.measurement).toEqual({ lengthMm: 100 });
    expect(await within(layer()).findByText('100.0 mm')).toBeInTheDocument();
  });

  it('asks for the text of an arrow before saving it', async () => {
    const user = userEvent.setup();
    const rec = serve(study, []);
    const { layer, background } = await open(study);

    await pickTool(user, 'Draw an arrow');
    fireEvent.pointerDown(background(), { ...at(50, 50), button: 0 });
    fireEvent.pointerUp(layer(), at(200, 120));
    const dialog = await findModal('Arrow text');
    await user.type(within(dialog).getByLabelText('Text'), 'Nodule');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(rec.created).toHaveLength(1));
    expect(rec.created[0]).toMatchObject({
      kind: 'ARROW',
      geometry: { from: [50, 50], to: [200, 120], text: 'Nodule' },
      measurement: null,
    });
  });

  it('moves an own annotation with its version, and lists others read-only', async () => {
    const user = userEvent.setup();
    const rec = serve(study, [annotation(), other]);
    const { layer } = await open(study);

    const hit = await waitFor(() => {
      const el = layer().querySelector('[data-annotation-id="ann-1"] .annotation-shape__hit');
      if (!el) throw new Error('not drawn yet');
      return el;
    });
    fireEvent.pointerDown(hit, { ...at(100, 150), button: 0 });
    fireEvent.pointerMove(layer(), at(110, 170));
    fireEvent.pointerUp(layer(), at(110, 170));

    await waitFor(() => expect(rec.updated).toHaveLength(1));
    expect(rec.updated[0]).toEqual({
      id: 'ann-1',
      body: {
        geometry: { x: 110, y: 140, width: 200, height: 150 },
        label: 'Nodule',
        note: null,
        measurement: { areaPx2: 30000 },
        version: 0,
      },
    });

    await openAnnotationsTab(user);
    expect(screen.getByRole('button', { name: 'Edit Nodule' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Length 2' })).not.toBeInTheDocument();
    expect(screen.getByText('Dr. Other')).toBeInTheDocument();
  });

  it('edits the label and note, then deletes, from the panel', async () => {
    const user = userEvent.setup();
    const rec = serve(study, [annotation()]);
    await open(study);
    await openAnnotationsTab(user);

    await user.click(await screen.findByRole('button', { name: 'Edit Nodule' }));
    const dialog = await findModal('Annotation');
    const label = within(dialog).getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Nodule, right upper zone');
    await user.type(within(dialog).getByLabelText('Note'), 'Compare with CT');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rec.updated).toHaveLength(1));
    expect(rec.updated[0]?.body).toMatchObject({
      label: 'Nodule, right upper zone',
      note: 'Compare with CT',
      version: 0,
    });
    expect(await screen.findByText('Compare with CT')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete Nodule, right upper zone' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(rec.deleted).toEqual(['ann-1']));
    expect(await screen.findByText('No annotations on this series')).toBeInTheDocument();
  });

  it('restores the annotation and reloads the list when the server reports a conflict', async () => {
    const user = userEvent.setup();
    const rec = serve(study, [annotation()], { conflict: true });
    const { layer } = await open(study);
    await openAnnotationsTab(user);
    await screen.findByRole('button', { name: 'Edit Nodule' });
    const listsBefore = rec.lists;

    const hit = layer().querySelector(
      '[data-annotation-id="ann-1"] .annotation-shape__hit',
    ) as Element;
    fireEvent.pointerDown(hit, { ...at(100, 150), button: 0 });
    fireEvent.pointerMove(layer(), at(150, 150));
    fireEvent.pointerUp(layer(), at(150, 150));

    expect(
      await screen.findByText(
        'This annotation was changed or deleted by someone else; the list has been reloaded.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(rec.lists).toBeGreaterThan(listsBefore));
    const outline = layer().querySelector('[data-annotation-id="ann-1"] path');
    expect(outline?.getAttribute('d')?.startsWith(`M${(OFFSET.x + 100 * SCALE).toFixed(1)},`)).toBe(
      true,
    );
  });

  it('lets a technician draw but not change a doctor’s annotation', async () => {
    const user = userEvent.setup();
    serve(study, [annotation()]);
    await open(study, technician);
    expect(screen.getByRole('button', { name: 'Draw a rectangle' })).toBeInTheDocument();
    await openAnnotationsTab(user);
    await screen.findByText('Nodule');
    expect(screen.queryByRole('button', { name: 'Edit Nodule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Nodule' })).not.toBeInTheDocument();
  });

  it('gives a researcher no drawing tools', async () => {
    serve(study, [annotation()]);
    await open(study, researcher);
    expect(screen.queryByRole('button', { name: 'Draw a rectangle' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show annotations' })).toBeInTheDocument();
  });
});
