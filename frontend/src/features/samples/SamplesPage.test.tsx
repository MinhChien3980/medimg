import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { SampleCaseDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { admin, ctStudy, researcher, sampleCases, SEG_JOB_ID, tokens } from '@/test/fixtures';
import { LocationProbe, renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import SamplesPage from './SamplesPage';

function renderSamples(samples: SampleCaseDto[]) {
  server.use(mock.get(`${API}/samples`, () => HttpResponse.json(samples)));
  return renderWithProviders(<SamplesPage />, {
    route: '/samples',
    extraRoutes: [
      { path: '/studies/:studyId', element: <LocationProbe /> },
      { path: '/cases/:caseId', element: <LocationProbe /> },
    ],
  });
}

const card = (title: string) => {
  const heading = screen.getByRole('heading', { name: title });
  const article = heading.closest('.sample-card');
  if (!(article instanceof HTMLElement)) throw new Error(`no card for ${title}`);
  return within(article);
};

describe('SamplesPage', () => {
  it('shows each sample with its thumbnail, description, modality and source, read-only roles included', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    renderSamples(sampleCases);

    expect(await screen.findByRole('heading', { name: 'Abdominal CT, 2 mm' })).toBeInTheDocument();
    const first = card('Abdominal CT, 2 mm');
    expect(first.getByRole('img', { name: 'Thumbnail of Abdominal CT, 2 mm' })).toHaveAttribute(
      'src',
      sampleCases[0]?.studies[0]?.thumbnailUrl,
    );
    expect(first.getByText('Portal venous phase, liver and kidneys in view.')).toBeInTheDocument();
    expect(first.getByText('CT · NIfTI')).toBeInTheDocument();
    expect(
      first.getByText(
        'Source: TotalSegmentator dataset (Zenodo 10047263), CC BY 4.0, Wasserthal et al. 2023',
      ),
    ).toBeInTheDocument();
    expect(first.getByText('Segmented')).toBeInTheDocument();

    const second = card('Thorax CT, not segmented yet');
    expect(second.getByText('CT · DICOM series')).toBeInTheDocument();
    expect(second.queryByText('Segmented')).not.toBeInTheDocument();
  });

  it('opens a segmented sample on its finished run, and links to the case', async () => {
    const user = userEvent.setup();
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));
    renderSamples(sampleCases);

    await screen.findByRole('heading', { name: 'Abdominal CT, 2 mm' });
    expect(
      card('Abdominal CT, 2 mm').getByRole('link', { name: /Case CASE-SAMPLE1/ }),
    ).toHaveAttribute('href', `/cases/${sampleCases[0]?.patientId}`);
    await user.click(
      screen.getByRole('button', { name: 'Open Abdominal CT, 2 mm (CT) in the viewer' }),
    );
    expect(await screen.findByTestId('location')).toHaveTextContent(
      `/studies/${ctStudy.id}?job=${SEG_JOB_ID}`,
    );
  });

  it('opens a sample without a finished run on the study itself', async () => {
    const user = userEvent.setup();
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    renderSamples(sampleCases);

    await user.click(
      await screen.findByRole('button', {
        name: 'Open Thorax CT, not segmented yet (CT) in the viewer',
      }),
    );
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/studies/13131313-1313-4131-8131-131313131313',
    );
    expect(screen.getByTestId('location').textContent).not.toContain('job=');
  });

  it('says when there are no samples, with a hint for admins only', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', admin));
    const { unmount } = renderSamples([]);
    expect(await screen.findByText('No sample cases yet')).toBeInTheDocument();
    expect(screen.getByText('Mark a case as a sample from its case page.')).toBeInTheDocument();
    unmount();

    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    renderSamples([]);
    expect(await screen.findByText('No sample cases yet')).toBeInTheDocument();
    expect(
      screen.queryByText('Mark a case as a sample from its case page.'),
    ).not.toBeInTheDocument();
  });

  it('shows a placeholder and refetches fresh URLs once when a thumbnail has expired', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    let calls = 0;
    server.use(
      mock.get(`${API}/samples`, () => {
        calls += 1;
        return HttpResponse.json(sampleCases.slice(0, 1));
      }),
    );
    renderWithProviders(<SamplesPage />, { route: '/samples' });

    const thumb = await screen.findByRole('img', { name: 'Thumbnail of Abdominal CT, 2 mm' });
    fireEvent.error(thumb);
    expect(
      await screen.findByRole('img', { name: 'Thumbnail of Abdominal CT, 2 mm' }),
    ).not.toHaveAttribute('src');
    await vi.waitFor(() => expect(calls).toBe(2));
  });
});
