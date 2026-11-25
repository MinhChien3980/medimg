import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InitUploadRequest, UploadDto } from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { RequirePermission } from '@/features/auth/RequirePermission';
import { LocationProbe, renderWithProviders } from '@/test/render';
import { ctStudy, model, patient, researcher, segModel, study, tokens } from '@/test/fixtures';
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
  progress: 30,
  inputType: 'IMAGE_2D',
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
          { ...processing, progress: 0, inputType: null },
          { status: 202 },
        );
      }),
      mock.get(`${API}/uploads/${UPLOAD_ID}`, () => {
        pollCalls += 1;
        return HttpResponse.json<UploadDto>(
          pollCalls < 2
            ? processing
            : { ...processing, status: 'DONE', progress: 100, studyId: study.id },
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
    // Server-side processing progress comes from `UploadDto.progress`.
    expect(
      await screen.findByRole('progressbar', { name: 'Server processing progress' }),
    ).toHaveAttribute('aria-valuenow', '30');
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

  it('rejects unsupported files and images larger than 50 MB', async () => {
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
    expect(
      await screen.findByText(
        'Only PNG/JPG images, NIfTI (.nii, .nii.gz) or a ZIP of DICOM files are accepted',
      ),
    ).toBeInTheDocument();

    const big = pngFile('big.png');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES.image + 1 });
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

    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_PROCESSING_TIMEOUT_MS.image));

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
    expect(screen.getByText('The server could not process the file')).toBeInTheDocument();
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

  describe('CT volume', () => {
    const VOLUME_PUT = '/medimg/uploads/u1/f1/ct.nii.gz?X-Amz-Signature=sig';
    const volumeProcessing: UploadDto = { ...processing, progress: 0, inputType: null };

    function niftiFile(): File {
      return new File([new Uint8Array(16)], 'ct.nii.gz', { type: '' });
    }

    function volumeHandlers({
      complete = () => HttpResponse.json(volumeProcessing, { status: 202 }),
      poll,
      onInit,
      onPut,
    }: {
      complete?: () => Response;
      poll: () => UploadDto;
      onInit?: (body: InitUploadRequest) => void;
      onPut?: (headers: Headers) => void;
    }) {
      return [
        mock.get(`${API}/patients/${patient.id}`, () => HttpResponse.json(patient)),
        mock.post(`${API}/uploads/init`, async ({ request }) => {
          onInit?.((await request.json()) as InitUploadRequest);
          return HttpResponse.json(
            {
              uploadId: UPLOAD_ID,
              files: [
                {
                  fileId: 'f1',
                  name: 'ct.nii.gz',
                  putUrl: VOLUME_PUT,
                  expiresAt: '2026-11-25T10:00:00Z',
                },
              ],
            },
            { status: 201 },
          );
        }),
        mock.put('*/medimg/uploads/u1/f1/ct.nii.gz', ({ request }) => {
          onPut?.(request.headers);
          return new HttpResponse(null, { status: 200 });
        }),
        mock.post(`${API}/uploads/${UPLOAD_ID}/complete`, complete),
        mock.get(`${API}/uploads/${UPLOAD_ID}`, () => HttpResponse.json(poll())),
        mock.get(`${API}/models`, ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams.get('inputType') === 'NIFTI' ? [segModel] : [model],
          ),
        ),
      ];
    }

    async function startVolumeUpload(user: ReturnType<typeof userEvent.setup>) {
      renderWithProviders(<UploadWizardPage />, {
        route: `/upload?caseId=${patient.id}`,
        path: '/upload',
      });
      const next = screen.getByRole('button', { name: 'Next' });
      await waitFor(() => expect(next).toBeEnabled());
      await user.click(next);
      await user.upload(fileInput(), niftiFile());
      expect(await screen.findByTestId('picked-file')).toHaveTextContent('CT volume');
      await user.click(screen.getByRole('button', { name: /Upload/ }));
    }

    it('uploads a NIfTI volume and shows the server processing progress', async () => {
      useAuthStore.getState().setSession(tokens('acc', 'ref'));
      const user = userEvent.setup({ applyAccept: false });
      let init: InitUploadRequest | null = null;
      let putType: string | null = null;
      let polls = 0;
      server.use(
        ...volumeHandlers({
          onInit: (body) => {
            init = body;
          },
          onPut: (headers) => {
            putType = headers.get('content-type');
          },
          poll: () => {
            polls += 1;
            if (polls === 1) return { ...volumeProcessing, progress: 40, inputType: 'NIFTI' };
            // An automatic ingest retry goes back to UPLOADED at 0 % before processing again.
            if (polls === 2) return { ...volumeProcessing, status: 'UPLOADED', progress: 0 };
            if (polls === 3) return { ...volumeProcessing, progress: 70, inputType: 'NIFTI' };
            return {
              ...volumeProcessing,
              status: 'DONE',
              progress: 100,
              inputType: 'NIFTI',
              studyId: ctStudy.id,
            };
          },
        }),
      );

      await startVolumeUpload(user);

      expect(await screen.findByText(/Server is processing the CT/)).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole('progressbar', { name: 'Server processing progress' }),
        ).toHaveAttribute('aria-valuenow', '40'),
      );
      expect(
        await screen.findByText('CT volume is ready', {}, { timeout: 8000 }),
      ).toBeInTheDocument();

      expect(init).toEqual({
        patientId: patient.id,
        files: [{ name: 'ct.nii.gz', size: 16, contentType: 'application/gzip' }],
        modalityHint: 'CT',
        bodyPartHint: 'ABDOMEN',
      });
      expect(putType).toBe('application/gzip');
      // The run button offers the models of the new study's input type.
      expect(await screen.findByText('CT organ segmentation')).toBeInTheDocument();
    }, 20_000);

    it('waits up to 10 minutes for a volume before giving up', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      useAuthStore.getState().setSession(tokens('acc', 'ref'));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, applyAccept: false });
      server.use(...volumeHandlers({ poll: () => ({ ...volumeProcessing, progress: 50 }) }));

      await startVolumeUpload(user);
      await screen.findByRole('progressbar', { name: 'Server processing progress' });

      await act(() => vi.advanceTimersByTimeAsync(UPLOAD_PROCESSING_TIMEOUT_MS.image + 1000));
      expect(screen.queryByText('Upload failed')).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(UPLOAD_PROCESSING_TIMEOUT_MS.volume));
      expect(await screen.findByText('Upload failed')).toBeInTheDocument();
      expect(
        screen.getByText(
          'The server took more than 10 minutes to process the CT. Please upload it again.',
        ),
      ).toBeInTheDocument();
    });

    it('shows why the server rejected the file right at completion', async () => {
      useAuthStore.getState().setSession(tokens('acc', 'ref'));
      const user = userEvent.setup({ applyAccept: false });
      const rejected: UploadDto = {
        ...volumeProcessing,
        status: 'FAILED',
        error: 'The file is not a NIfTI volume',
      };
      server.use(
        ...volumeHandlers({
          complete: () => HttpResponse.json(rejected, { status: 202 }),
          poll: () => rejected,
        }),
      );

      await startVolumeUpload(user);

      expect(await screen.findByText('Upload failed')).toBeInTheDocument();
      expect(screen.getByText('The file is not a NIfTI volume')).toBeInTheDocument();
    });

    it('rejects a volume larger than 500 MB', async () => {
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

      const big = niftiFile();
      Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES.volume + 1 });
      await user.upload(fileInput(), big);
      expect(await screen.findByText('The CT file exceeds 500 MB')).toBeInTheDocument();
      expect(screen.queryByTestId('picked-file')).not.toBeInTheDocument();
    });
  });
});
