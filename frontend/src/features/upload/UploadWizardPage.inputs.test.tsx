/**
 * Upload wizard, slice 2b: DICOM X-ray, ZIP of PNG/JPG slices with voxel spacing, and multipart
 * uploads of large files (the server decides: `putUrl: null` + `multipart` in `uploads/init`).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mock, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CompleteUploadRequest,
  InitUploadFile,
  InitUploadRequest,
  UploadDto,
} from '@/api/types';
import { useAuthStore } from '@/features/auth/authStore';
import { model, patient, stackStudy, dicomXrayStudy, tokens } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { API, server } from '@/test/server';
import UploadWizardPage from './UploadWizardPage';

const UPLOAD_ID = '66666666-6666-4666-8666-666666666666';
const STORAGE = '/medimg/uploads/u1/f1';

type User = ReturnType<typeof userEvent.setup>;

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
  progress: 10,
  inputType: null,
};

interface Recorded {
  init: InitUploadRequest | null;
  complete: { calls: number; body: CompleteUploadRequest | null };
  puts: Array<{
    path: string;
    partNumber: string | null;
    type: string | null;
    auth: string | null;
    bytes: number[];
  }>;
}

/**
 * Backend for one upload of `name`: `target` is the file entry `uploads/init` returns. Storage
 * PUTs answer with a quoted ETag, as S3 / SeaweedFS do. `done` is the final UploadDto.
 */
function serveUpload({
  name,
  target,
  done,
  models = [],
  putStatus = () => 200,
}: {
  name: string;
  target: Partial<InitUploadFile>;
  done: Partial<UploadDto>;
  models?: unknown[];
  putStatus?: (partNumber: string | null) => number;
}): Recorded {
  const recorded: Recorded = { init: null, complete: { calls: 0, body: null }, puts: [] };
  let polls = 0;
  server.use(
    mock.get(`${API}/patients/${patient.id}`, () => HttpResponse.json(patient)),
    mock.post(`${API}/uploads/init`, async ({ request }) => {
      recorded.init = (await request.json()) as InitUploadRequest;
      return HttpResponse.json(
        {
          uploadId: UPLOAD_ID,
          files: [
            {
              fileId: 'f1',
              name,
              putUrl: `${STORAGE}/${name}?X-Amz-Signature=sig`,
              expiresAt: '2026-11-25T10:00:00Z',
              ...target,
            },
          ],
        },
        { status: 201 },
      );
    }),
    mock.put(`*${STORAGE}/${name}`, async ({ request }) => {
      const partNumber = new URL(request.url).searchParams.get('partNumber');
      recorded.puts.push({
        path: new URL(request.url).pathname,
        partNumber,
        type: request.headers.get('content-type'),
        auth: request.headers.get('authorization'),
        bytes: [...new Uint8Array(await request.arrayBuffer())],
      });
      const status = putStatus(partNumber);
      return new HttpResponse(null, {
        status,
        headers: status === 200 ? { ETag: `"etag-${partNumber ?? 'single'}"` } : {},
      });
    }),
    mock.post(`${API}/uploads/${UPLOAD_ID}/complete`, async ({ request }) => {
      recorded.complete.calls += 1;
      const text = await request.text();
      recorded.complete.body = text ? (JSON.parse(text) as CompleteUploadRequest) : null;
      return HttpResponse.json(processing, { status: 202 });
    }),
    mock.get(`${API}/uploads/${UPLOAD_ID}`, () => {
      polls += 1;
      return HttpResponse.json<UploadDto>(
        polls < 2 ? processing : { ...processing, status: 'DONE', progress: 100, ...done },
      );
    }),
    mock.get(`${API}/models`, () => HttpResponse.json(models)),
  );
  return recorded;
}

async function openFileStep(user: User) {
  renderWithProviders(<UploadWizardPage />, {
    route: `/upload?caseId=${patient.id}`,
    path: '/upload',
  });
  const next = screen.getByRole('button', { name: 'Next' });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
}

const uploadButton = () => screen.getByRole('button', { name: /Upload$/ });

function zipFile(): File {
  return new File([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4])], 'slices.zip', {
    type: 'application/x-zip-compressed',
  });
}

describe('UploadWizardPage, slice 2b inputs', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
  });

  it('uploads a DICOM X-ray as application/dicom and opens it like any 2D image', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const recorded = serveUpload({
      name: 'chest.dcm',
      target: {},
      done: { inputType: 'DICOM_2D', studyId: dicomXrayStudy.id },
      models: [model],
    });
    await openFileStep(user);

    // Windows reports .dcm files without a type: the content type comes from the extension.
    await user.upload(fileInput(), new File([new Uint8Array(132)], 'chest.dcm', { type: '' }));
    expect(await screen.findByTestId('picked-file')).toHaveTextContent('DICOM X-ray');
    expect(screen.queryByTestId('zip-content')).not.toBeInTheDocument();
    await user.click(uploadButton());

    expect(await screen.findByText(/Server is decoding the DICOM X-ray/)).toBeInTheDocument();
    expect(await screen.findByText('Image is ready', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(recorded.init).toEqual({
      patientId: patient.id,
      files: [{ name: 'chest.dcm', size: 132, contentType: 'application/dicom' }],
      modalityHint: 'CR',
      bodyPartHint: 'CHEST',
    });
    expect(recorded.puts).toHaveLength(1);
    expect(recorded.puts[0]?.type).toBe('application/dicom');
    expect(recorded.complete.body).toBeNull();
    expect(await screen.findByText(model.name)).toBeInTheDocument();
  });

  describe('ZIP of PNG/JPG slices', () => {
    it('asks what the ZIP holds and reveals the optional spacing with the 1 mm warning up front', async () => {
      const user = userEvent.setup({ applyAccept: false });
      serveUpload({ name: 'slices.zip', target: {}, done: {} });
      await openFileStep(user);
      await user.upload(fileInput(), zipFile());

      const dicomSeries = await screen.findByRole('radio', { name: 'One DICOM series (CT/MR)' });
      expect(dicomSeries).toBeChecked();
      expect(
        screen.getByRole('radiogroup', { name: 'What does the ZIP contain?' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('spinbutton', { name: 'Slice spacing z' })).not.toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Modality' })).toBeInTheDocument();
      expect(screen.getByTitle('CT')).toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: /PNG\/JPG slices/ }));
      for (const name of [
        'Pixel spacing x (columns)',
        'Pixel spacing y (rows)',
        'Slice spacing z',
      ]) {
        expect(screen.getByRole('spinbutton', { name })).toHaveValue('');
      }
      expect(
        screen.getByText(/Without a spacing the server assumes 1 mm in every direction/),
      ).toBeInTheDocument();
      expect(screen.getByTestId('picked-file')).toHaveTextContent('Image stack (3D)');
      // The worker's slice order and orientation convention is spelled out.
      expect(screen.getByText(/natural order \(img2 before img10\)/)).toHaveTextContent(
        "the first file is the most inferior slice (towards the feet), and the left of each image is the patient's right",
      );
      // An image stack is always stored as OT.
      expect(screen.getByTitle('OT')).toBeInTheDocument();

      await user.type(screen.getByRole('spinbutton', { name: 'Slice spacing z' }), '2');
      await waitFor(() =>
        expect(screen.queryByText(/Without a spacing the server assumes/)).not.toBeInTheDocument(),
      );
    });

    it.each([
      [
        'a value out of 0.01–20 mm',
        { x: '25', y: '1', z: '1' },
        'Enter a value between 0.01 and 20 mm',
      ],
      ['a value of 0', { x: '1', y: '0', z: '1' }, 'Enter a value between 0.01 and 20 mm'],
      [
        'a partial entry',
        { x: '0.8', y: '0.8' },
        'Fill in all three values or leave them all empty',
      ],
    ])('refuses %s and does not start the upload', async (_name, values, error) => {
      const user = userEvent.setup({ applyAccept: false });
      const recorded = serveUpload({ name: 'slices.zip', target: {}, done: {} });
      await openFileStep(user);
      await user.upload(fileInput(), zipFile());
      await user.click(await screen.findByRole('radio', { name: /PNG\/JPG slices/ }));

      const labels = {
        x: 'Pixel spacing x (columns)',
        y: 'Pixel spacing y (rows)',
        z: 'Slice spacing z',
      };
      for (const [axis, value] of Object.entries(values)) {
        await user.type(screen.getByRole('spinbutton', { name: labels[axis as 'x'] }), value);
      }
      await user.click(uploadButton());

      expect((await screen.findAllByText(error)).length).toBeGreaterThan(0);
      expect(screen.queryByTestId('process-step')).not.toBeInTheDocument();
      expect(recorded.init).toBeNull();
    });

    it('sends the spacing with the upload and shows the stack once the server has built it', async () => {
      const user = userEvent.setup({ applyAccept: false });
      const recorded = serveUpload({
        name: 'slices.zip',
        target: {},
        done: { inputType: 'IMAGE_STACK', studyId: stackStudy.id },
        models: [],
      });
      await openFileStep(user);
      await user.upload(fileInput(), zipFile());
      await user.click(await screen.findByRole('radio', { name: /PNG\/JPG slices/ }));
      await user.type(screen.getByRole('spinbutton', { name: 'Pixel spacing x (columns)' }), '0.7');
      await user.type(screen.getByRole('spinbutton', { name: 'Pixel spacing y (rows)' }), '0.7');
      await user.type(screen.getByRole('spinbutton', { name: 'Slice spacing z' }), '2.5');
      await user.click(uploadButton());

      expect(await screen.findByText(/building the volume from the slices/)).toBeInTheDocument();
      expect(
        await screen.findByText('Image stack volume is ready', {}, { timeout: 5000 }),
      ).toBeInTheDocument();
      expect(recorded.init).toEqual({
        patientId: patient.id,
        files: [{ name: 'slices.zip', size: 8, contentType: 'application/zip' }],
        modalityHint: 'OT',
        bodyPartHint: 'ABDOMEN',
        sliceSpacingMm: [0.7, 0.7, 2.5],
      });
      expect(recorded.puts[0]?.type).toBe('application/zip');
      // No model accepts an image stack.
      expect(await screen.findByText('No AI model for this image type')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Run AI/ })).not.toBeInTheDocument();
    });

    it('leaves the spacing out when it is empty (the server assumes 1 mm)', async () => {
      const user = userEvent.setup({ applyAccept: false });
      const recorded = serveUpload({ name: 'slices.zip', target: {}, done: {} });
      await openFileStep(user);
      await user.upload(fileInput(), zipFile());
      await user.click(await screen.findByRole('radio', { name: /PNG\/JPG slices/ }));
      await user.click(uploadButton());

      await screen.findByTestId('process-step');
      await waitFor(() => expect(recorded.init).not.toBeNull());
      expect(recorded.init).not.toHaveProperty('sliceSpacingMm');
    });
  });

  describe('multipart upload', () => {
    /** 10 bytes in parts of 4: [0..3], [4..7], [8..9]. */
    const PART_SIZE = 4;
    const bigFile = () =>
      new File([new Uint8Array(10).map((_, i) => i)], 'big.nii.gz', { type: 'application/gzip' });
    const multipart = {
      putUrl: null,
      multipart: {
        partSize: PART_SIZE,
        parts: [1, 2, 3].map((n) => ({
          partNumber: n,
          url: `${STORAGE}/big.nii.gz?uploadId=mp&partNumber=${n}&X-Amz-Signature=s${n}`,
        })),
      },
    };

    it('uploads every part without Authorization, then completes with the ETags in part order', async () => {
      const user = userEvent.setup({ applyAccept: false });
      const recorded = serveUpload({
        name: 'big.nii.gz',
        target: multipart,
        done: { inputType: 'NIFTI', studyId: 'study-mp' },
      });
      await openFileStep(user);
      await user.upload(fileInput(), bigFile());
      await user.click(uploadButton());

      expect(
        await screen.findByText('CT volume is ready', {}, { timeout: 5000 }),
      ).toBeInTheDocument();
      const parts = [...recorded.puts].sort((a, b) => Number(a.partNumber) - Number(b.partNumber));
      expect(parts.map((p) => [p.partNumber, p.bytes])).toEqual([
        ['1', [0, 1, 2, 3]],
        ['2', [4, 5, 6, 7]],
        ['3', [8, 9]],
      ]);
      for (const p of parts) {
        expect(p.auth).toBeNull();
        expect(p.type).toBeNull();
      }
      expect(recorded.complete.calls).toBe(1);
      expect(recorded.complete.body).toEqual({
        files: [
          {
            fileId: 'f1',
            parts: [
              { partNumber: 1, etag: '"etag-1"' },
              { partNumber: 2, etag: '"etag-2"' },
              { partNumber: 3, etag: '"etag-3"' },
            ],
          },
        ],
      });
    });

    it('stops at a part that storage refuses and does not complete the upload', async () => {
      const user = userEvent.setup({ applyAccept: false });
      const recorded = serveUpload({
        name: 'big.nii.gz',
        target: multipart,
        done: {},
        putStatus: (part) => (part === '2' ? 403 : 200),
      });
      await openFileStep(user);
      await user.upload(fileInput(), bigFile());
      await user.click(uploadButton());

      expect(await screen.findByText('Upload failed')).toBeInTheDocument();
      expect(
        screen.getByText('Storage refused part 2 of the file (HTTP 403). Please try again.'),
      ).toBeInTheDocument();
      expect(recorded.complete.calls).toBe(0);
      // 403 is not transient: no retry of part 2.
      expect(recorded.puts.filter((p) => p.partNumber === '2')).toHaveLength(1);
    });

    it('cancels the transfer: parts in flight are aborted and the file step comes back', async () => {
      const user = userEvent.setup({ applyAccept: false });
      const recorded = serveUpload({ name: 'big.nii.gz', target: multipart, done: {} });
      const aborted: string[] = [];
      server.use(
        mock.put(`*${STORAGE}/big.nii.gz`, async ({ request }) => {
          const part = new URL(request.url).searchParams.get('partNumber') ?? '';
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => {
              aborted.push(part);
              resolve();
            }),
          );
          return HttpResponse.error();
        }),
      );
      await openFileStep(user);
      await user.upload(fileInput(), bigFile());
      await user.click(uploadButton());

      await user.click(await screen.findByRole('button', { name: 'Cancel upload' }));

      expect(await screen.findByTestId('picked-file')).toHaveTextContent('big.nii.gz');
      await waitFor(() => expect(aborted.sort()).toEqual(['1', '2', '3']));
      expect(recorded.complete.calls).toBe(0);
      expect(screen.queryByText('Upload failed')).not.toBeInTheDocument();
    });
  });
});
