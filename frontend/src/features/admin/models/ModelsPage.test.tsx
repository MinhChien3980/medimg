import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { AdminModelDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { admin, adminModel, model, segModel, tokens } from '@/test/fixtures';
import { findModal } from '@/test/modal';
import { createTestQueryClient, renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import ModelsPage from './ModelsPage';

const segmentation = adminModel({
  id: segModel.id,
  code: segModel.code,
  version: segModel.version,
  name: segModel.name,
  task: 'SEGMENTATION_3D',
  inputTypes: ['NIFTI', 'DICOM_SERIES'],
  modality: 'CT',
  status: 'DISABLED',
  stats: {
    jobs: 0,
    done: 0,
    failed: 0,
    avgInferenceMs: null,
    p95InferenceMs: null,
    lastUsedAt: null,
  },
});

function modelsBackend(models: AdminModelDto[]) {
  const state = models.map((m) => ({ ...m }));
  const calls: string[] = [];
  server.use(
    mock.get(`${API}/admin/models`, () => HttpResponse.json(state)),
    mock.post(`${API}/admin/models/:id/:action`, ({ params }) => {
      calls.push(`${String(params.id)}/${String(params.action)}`);
      const m = state.find((x) => x.id === params.id);
      if (!m) return HttpResponse.json({ status: 404 }, { status: 404 });
      m.status = params.action === 'disable' ? 'DISABLED' : 'ACTIVE';
      return HttpResponse.json(m);
    }),
  );
  return calls;
}

function renderModels() {
  useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
  const queryClient = createTestQueryClient();
  const result = renderWithProviders(<ModelsPage />, { route: '/admin/models', queryClient });
  return { ...result, queryClient };
}

async function rowOf(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name, { selector: 'strong' });
  return cell.closest('tr') as HTMLElement;
}

describe('ModelsPage', () => {
  it('lists every model with its statistics', async () => {
    modelsBackend([adminModel(), segmentation]);
    renderModels();

    const cxr = await rowOf(model.name);
    expect(within(cxr).getByText(`${model.code}@${model.version}`)).toBeInTheDocument();
    expect(within(cxr).getByText('Classification (2D)')).toBeInTheDocument();
    expect(within(cxr).getByText('2D image')).toBeInTheDocument();
    expect(within(cxr).getByText('DICOM X-ray')).toBeInTheDocument();
    expect(within(cxr).getByText('Active')).toBeInTheDocument();
    expect(within(cxr).getByText('1,234')).toBeInTheDocument();
    expect(within(cxr).getByText('1,200')).toBeInTheDocument();
    expect(within(cxr).getByText('812 ms')).toBeInTheDocument();
    expect(within(cxr).getByText('1.5 s')).toBeInTheDocument();

    const seg = await rowOf(segModel.name);
    expect(within(seg).getByText('Disabled')).toBeInTheDocument();
    expect(within(seg).getByText('Segmentation (3D)')).toBeInTheDocument();
    // No job yet: no times, never used.
    expect(within(seg).getAllByText('—')).toHaveLength(3);
  });

  it('disables a model after a confirmation and refreshes the AI panel lists', async () => {
    const user = userEvent.setup();
    const calls = modelsBackend([adminModel()]);
    const { queryClient } = renderModels();
    queryClient.setQueryData(['models', 'IMAGE_2D'], [model]);
    const row = await rowOf(model.name);

    await user.click(within(row).getByRole('button', { name: 'Disable' }));
    const confirm = await findModal(`Disable ${model.name}?`);
    expect(
      within(confirm).getByText(/Jobs already queued or running finish normally/),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Disable' }));

    expect(await screen.findByText(`${model.name} disabled`)).toBeInTheDocument();
    expect(calls).toEqual([`${model.id}/disable`]);
    expect(await within(await rowOf(model.name)).findByText('Disabled')).toBeInTheDocument();
    expect(queryClient.getQueryState(['models', 'IMAGE_2D'])?.isInvalidated).toBe(true);
  });

  it('enables a disabled model after a confirmation', async () => {
    const user = userEvent.setup();
    const calls = modelsBackend([segmentation]);
    renderModels();
    const row = await rowOf(segModel.name);

    await user.click(within(row).getByRole('button', { name: 'Enable' }));
    const confirm = await findModal(`Enable ${segModel.name}?`);
    await user.click(within(confirm).getByRole('button', { name: 'Enable' }));

    expect(await screen.findByText(`${segModel.name} enabled`)).toBeInTheDocument();
    expect(calls).toEqual([`${segModel.id}/enable`]);
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    const calls = modelsBackend([adminModel()]);
    renderModels();
    const row = await rowOf(model.name);

    await user.click(within(row).getByRole('button', { name: 'Disable' }));
    await user.click(
      within(await findModal(`Disable ${model.name}?`)).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls).toEqual([]);
  });

  it('shows a refusal and keeps the model as it was', async () => {
    const user = userEvent.setup();
    modelsBackend([adminModel()]);
    server.use(
      mock.post(`${API}/admin/models/:id/disable`, () =>
        HttpResponse.json({ status: 409, detail: 'Model is already disabled' }, { status: 409 }),
      ),
    );
    renderModels();
    const row = await rowOf(model.name);
    await user.click(within(row).getByRole('button', { name: 'Disable' }));
    await user.click(
      within(await findModal(`Disable ${model.name}?`)).getByRole('button', { name: 'Disable' }),
    );

    expect(await screen.findByText('Model is already disabled')).toBeInTheDocument();
    expect(within(await rowOf(model.name)).getByText('Active')).toBeInTheDocument();
  });

  it('shows an empty list and load errors', async () => {
    server.use(mock.get(`${API}/admin/models`, () => HttpResponse.json([])));
    renderModels();
    expect(await screen.findByText('No model is registered')).toBeInTheDocument();
  });

  it('shows a load error with a retry', async () => {
    server.use(
      mock.get(`${API}/admin/models`, () =>
        HttpResponse.json({ status: 503, detail: 'Service unavailable' }, { status: 503 }),
      ),
    );
    renderModels();
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
