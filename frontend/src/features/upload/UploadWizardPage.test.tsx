import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InitUploadRequest, UploadDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { RequirePermission } from '@/features/auth/RequirePermission';
import { LocationProbe, renderWithProviders } from '@/test/render';
import { model, patient, researcher, study, tokens } from '@/test/fixtures';
import { API, server } from '@/test/server';
import UploadWizardPage from './UploadWizardPage';
import { MAX_UPLOAD_BYTES } from './fileValidation';
import { UPLOAD_POLL_MS, UPLOAD_PROCESSING_TIMEOUT_MS } from './useUploadFlow';

const UPLOAD_ID = '66666666-6666-4666-8666-666666666666';
const PUT_URL = '/medimg/uploads/u1/f1/chest.png?X-Amz-Signature=sig';

function pngFile(name = 'chest.png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], name, {
    type: 'image/png',
  });
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input;
}

const processing: UploadDto = {
  uploadId: UPLOAD_ID,
  status: 'PROCESSING',
  error: null,
  studyId: null,
};

/** Case lookup, init and PUT succeed; `complete` and the status poll are up to the test. */
function uploadHandlers({
  complete = () => HttpResponse.json(processing, { status: 202 }),
  poll,
}: {
  complete?: () => Response;
  poll: () => UploadDto;
}) {
  return [
    mock.get(`${API}/patients/${patient.id}`, () => HttpResponse.json(patient)),
    mock.post(`${API}/uploads/init`, () =>
      HttpResponse.json(
        {
          uploadId: UPLOAD_ID,
          files: [
            { fileId: 'f1', name: 'chest.png', putUrl: PUT_URL, expiresAt: '2026-11-25T10:00:00Z' },
          ],
        },
        { status: 201 },
      ),
    ),
    mock.put('*/medimg/uploads/u1/f1/chest.png', () => new HttpResponse(null, { status: 200 })),
    mock.post(`${API}/uploads/${UPLOAD_ID}/complete`, complete),
    mock.get(`${API}/uploads/${UPLOAD_ID}`, () => HttpResponse.json(poll())),
  ];
}

/** Opens the wizard on a preselected case, picks a PNG and starts the upload. */
async function startUpload(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<UploadWizardPage />, {
    route: `/upload?caseId=${patient.id}`,
    path: '/upload',
  });
  const next = screen.getByRole('button', { name: 'Next' });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
  await user.upload(fileInput(), pngFile());
  await user.click(await screen.findByRole('button', { name: /Upload/ }));
}

describe('UploadWizardPage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: pick case → drop PNG → init → PUT → complete → poll → open viewer', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    const user = userEvent.setup();

    let initBody: InitUploadRequest | null = null;
    let putHeaders: Headers | null = null;
    let putBytes = 0;
    let completeCalls = 0;
    let pollCalls = 0;

    server.use(
      mock.get(`${API}/patients`, () =>
        HttpResponse.json({
          content: [patient],
          page: 0,
          size: 20,
          totalElements: 1,
          totalPages: 1,
        }),
      ),
      mock.post(`${API}/uploads/init`, async ({ request }) => {
        initBody = (await request.json()) as InitUploadRequest;
        return HttpResponse.json(
          {
            uploadId: UPLOAD_ID,
            files: [
              {
                fileId: 'f1',
                name: 'chest.png',
                putUrl: PUT_URL,
                expiresAt: '2026-11-25T10:00:00Z',
              },
            ],
          },
          { status: 201 },
        );
      }),
      mock.put('*/medimg/uploads/u1/f1/chest.png', async ({ request }) => {
        putHeaders = request.headers;
        putBytes = (await request.arrayBuffer()).byteLength;
        return new HttpResponse(null, { status: 200 });
      }),
      mock.post(`${API}/uploads/${UPLOAD_ID}/complete`, () => {
        completeCalls += 1;
        return HttpResponse.json<UploadDto>(
          { uploadId: UPLOAD_ID, status: 'PROCESSING', error: null, studyId: null },
          { status: 202 },
        );
      }),
      mock.get(`${API}/uploads/${UPLOAD_ID}`, () => {
        pollCalls += 1;
        return HttpResponse.json<UploadDto>(
          pollCalls < 2
            ? { uploadId: UPLOAD_ID, status: 'PROCESSING', error: null, studyId: null }
            : { uploadId: UPLOAD_ID, status: 'DONE', error: null, studyId: study.id },
        );
      }),
      mock.get(`${API}/models`, () => HttpResponse.json([model])),
    );

    renderWithProviders(<UploadWizardPage />, {
      route: '/upload',
      extraRoutes: [{ path: '/studies/:studyId', element: <LocationProbe /> }],
    });

    // Step 1: pick the case from the searchable select.
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: 'Search case code…' }));
    await user.click(await screen.findByText('CASE-000001 · follow-up'));
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);

    // Step 2: drop one PNG, defaults CR / CHEST.
    await user.upload(fileInput(), pngFile());
    expect(await screen.findByTestId('picked-file')).toHaveTextContent('chest.png');
    await user.click(screen.getByRole('button', { name: /Upload/ }));

    // Step 3: processing → done.
    expect(await screen.findByRole('progressbar', { name: 'Upload progress' })).toBeInTheDocument();
    expect(await screen.findByText('Image is ready', {}, { timeout: 5000 })).toBeInTheDocument();

    expect(initBody).toEqual({
      patientId: patient.id,
      files: [{ name: 'chest.png', size: 8, contentType: 'image/png' }],
      modalityHint: 'CR',
      bodyPartHint: 'CHEST',
    });
    const headers = putHeaders as Headers | null;
    expect(headers?.get('content-type')).toBe('image/png');
    expect(headers?.get('authorization')).toBeNull(); // never send the JWT to S3
    expect(putBytes).toBe(8);
    expect(completeCalls).toBe(1);
    expect(pollCalls).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole('button', { name: /Open viewer/ }));
    expect(await screen.findByTestId('location')).toHaveTextContent(`/studies/${study.id}`);
  });

  it('rejects files that are not PNG/JPG or larger than 50 MB', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    const user = userEvent.setup({ applyAccept: false });
    server.use(mock.get(`${API}/patients/${patient.id}`, () => HttpResponse.json(patient)));

    renderWithProviders(<UploadWizardPage />, {
      route: `/upload?caseId=${patient.id}`,
      path: '/upload',
    });

    const next = screen.getByRole('button', { name: 'Next' });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);

    await user.upload(fileInput(), new File(['x'], 'scan.dcm', { type: 'application/dicom' }));
    expect(await screen.findByText('Only PNG or JPG images are accepted')).toBeInTheDocument();

    const big = pngFile('big.png');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    await user.upload(fileInput(), big);
    expect(await screen.findByText('The image exceeds 50 MB')).toBeInTheDocument();

    expect(screen.queryByTestId('picked-file')).not.toBeInTheDocument();
    const steps = document.querySelector('.ant-steps');
    expect(steps && within(steps as HTMLElement).queryByText('big.png')).toBeFalsy();
  });

  it('stops polling after the processing timeout and offers retry / back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let polls = 0;
    server.use(
      ...uploadHandlers({
        poll: () => {
          polls += 1;
          return processing;
        },
      }),
    );

    await startUpload(user);
    expect(
      await screen.findByText(
        'Server is processing the image (format check, normalisation, thumbnail)…',
      ),
    ).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_PROCESSING_TIMEOUT_MS));

    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The server is taking too long to process the image. Please upload it again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();

    const settled = polls;
    expect(settled).toBeGreaterThan(1);
    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_POLL_MS * 5));
    expect(polls).toBe(settled);
  });

  it('shows why the server rejected the image while processing it', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    const user = userEvent.setup();
    server.use(
      ...uploadHandlers({
        poll: () => ({
          ...processing,
          status: 'FAILED',
          error: 'Image is larger than 50 megapixels',
        }),
      }),
    );

    await startUpload(user);

    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    expect(screen.getByText('The server could not process the image')).toBeInTheDocument();
    expect(screen.getByText('Image is larger than 50 megapixels')).toBeInTheDocument();
  });

  it('shows a ProblemDetail returned when completing the upload', async () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
    const user = userEvent.setup();
    server.use(
      ...uploadHandlers({
        complete: () =>
          HttpResponse.json(
            {
              title: 'Unprocessable Entity',
              status: 422,
              detail: 'Image is larger than 50 megapixels',
            },
            { status: 422 },
          ),
        poll: () => processing,
      }),
    );

    await startUpload(user);

    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    expect(screen.getByText('Image is larger than 50 megapixels')).toBeInTheDocument();
  });

  it('is not available to a read-only researcher', () => {
    useAuthStore.getState().setSession(tokens('acc', 'ref', researcher));

    renderWithProviders(
      <RequirePermission permission="upload">
        <UploadWizardPage />
      </RequirePermission>,
      { route: '/upload' },
    );

    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });
});
