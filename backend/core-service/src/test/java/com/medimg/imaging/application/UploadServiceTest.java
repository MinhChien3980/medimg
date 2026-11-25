package com.medimg.imaging.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.util.unit.DataSize;

import com.medimg.imaging.application.ImagingDtos.CompletedFile;
import com.medimg.imaging.application.ImagingDtos.FileSpec;
import com.medimg.imaging.application.ImagingDtos.InitUpload;
import com.medimg.imaging.application.ImagingDtos.InitUploadResponse;
import com.medimg.imaging.application.ImagingDtos.PartUrl;
import com.medimg.imaging.application.ImagingDtos.PresignedFile;
import com.medimg.imaging.application.ImagingDtos.UploadDto;
import com.medimg.imaging.application.UploadService.UploadCompleted;
import com.medimg.imaging.domain.IngestInput;
import com.medimg.imaging.domain.Study.InputType;
import com.medimg.imaging.domain.UploadFile;
import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.infrastructure.UploadSessionRepository;
import com.medimg.patient.application.PatientService;
import com.medimg.shared.storage.MultipartUploadRejectedException;
import com.medimg.shared.storage.ObjectNotFoundException;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.storage.ObjectStoragePort.PresignedUrl;
import com.medimg.shared.storage.ObjectStoragePort.UploadedPart;
import com.medimg.shared.web.ApiException;
import com.medimg.support.TestFiles;

class UploadServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");
    private static final UUID USER = UUID.randomUUID();
    private static final long MB = 1024 * 1024;

    private final UploadSessionRepository uploads = mock(UploadSessionRepository.class);
    private final ObjectStoragePort storage = mock(ObjectStoragePort.class);
    private final IngestDispatcher ingest = mock(IngestDispatcher.class);
    private final RawUploads rawUploads = mock(RawUploads.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final ImagingProperties props = new ImagingProperties(50 * MB, 256, Duration.ofMinutes(10),
            new ImagingProperties.Volume(500 * MB, Duration.ofMinutes(30), 3, List.of(Duration.ofSeconds(30))),
            new ImagingProperties.Multipart(DataSize.ofMegabytes(64), DataSize.ofMegabytes(32), Duration.ofHours(1),
                    Duration.ofHours(2)));
    private final UploadService service = new UploadService(uploads, mock(PatientService.class), storage, ingest,
            rawUploads, props, events, Clock.fixed(NOW, ZoneOffset.UTC));

    @BeforeEach
    void setUp() {
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "none").subject(USER.toString()).build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
        when(storage.presignPut(anyString(), anyString(), anyLong()))
                .thenReturn(new PresignedUrl(URI.create("http://s3/put"), NOW.plusSeconds(900)));
        when(storage.createMultipartUpload(anyString(), anyString())).thenReturn("mp-1");
        when(storage.presignUploadPart(anyString(), eq("mp-1"), anyInt(), anyLong(), eq(Duration.ofHours(1))))
                .thenAnswer(i -> new PresignedUrl(URI.create("http://s3/part/" + i.getArgument(2)),
                        NOW.plus(Duration.ofHours(1)).plusSeconds(i.<Integer>getArgument(2))));
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void initSetsDefaultHintsAndSizeLimitByKind() {
        service.init(init("ct.nii.gz", 500 * MB, "application/gzip"));
        service.init(init("cxr.png", 50 * MB, "image/png"));
        service.init(init("cxr.dcm", 50 * MB, "application/octet-stream"));

        ArgumentCaptor<UploadSession> saved = ArgumentCaptor.forClass(UploadSession.class);
        verify(uploads, times(3)).save(saved.capture());
        assertThat(saved.getAllValues().get(0).getModalityHint()).isEqualTo("CT");
        assertThat(saved.getAllValues().get(0).getBodyPartHint()).isNull();
        assertThat(saved.getAllValues().get(1).getModalityHint()).isEqualTo("CR");
        assertThat(saved.getAllValues().get(1).getBodyPartHint()).isEqualTo("CHEST");
        assertThat(saved.getAllValues().get(2).getModalityHint()).isEqualTo("CR");

        assertBadRequest(init("ct.nii", 500 * MB + 1, "application/octet-stream"), "500 MB");
        assertBadRequest(init("cxr.jpg", 50 * MB + 1, "image/jpeg"), "50 MB");
        assertBadRequest(init("cxr.dcm", 50 * MB + 1, "application/dicom"), "50 MB");
        assertBadRequest(init("series.zip", 0, "application/zip"), "between 1 byte");
        assertBadRequest(init("scan.dcm", 10, "image/dicom"), "Unsupported file");
        assertBadRequest(init("scan.bin", 10, "application/octet-stream"), "Unsupported file");
        assertBadRequest(init("ct.nii.gz.zip", 10, "application/gzip"), "Unsupported file");
    }

    @Test
    void sliceSpacingIsKeptForAZipOnly() {
        List<Double> spacing = List.of(0.5, 0.5, 2.0);
        service.init(new InitUpload(UUID.randomUUID(), List.of(new FileSpec("slices.zip", 10, "application/zip")),
                null, null, spacing));

        ArgumentCaptor<UploadSession> saved = ArgumentCaptor.forClass(UploadSession.class);
        verify(uploads).save(saved.capture());
        assertThat(saved.getValue().requestedSpacing()).isEqualTo(spacing);
        assertBadRequest(new InitUpload(UUID.randomUUID(), List.of(new FileSpec("ct.nii", 10, "application/octet-stream")),
                null, null, spacing), "only applies to a ZIP");
    }

    @Test
    void fileAboveTheThresholdIsUploadedInParts() {
        long size = 70 * MB;

        InitUploadResponse response = service.init(init("ct.zip", size, "application/zip"));

        PresignedFile file = response.files().getFirst();
        assertThat(file.putUrl()).isNull();
        assertThat(file.multipart().partSize()).isEqualTo(32 * MB);
        assertThat(file.multipart().parts()).extracting(PartUrl::partNumber).containsExactly(1, 2, 3);
        assertThat(file.multipart().parts().get(2).url()).isEqualTo(URI.create("http://s3/part/3"));
        assertThat(file.expiresAt()).isEqualTo(NOW.plus(Duration.ofHours(1)).plusSeconds(1)); // the earliest
        ArgumentCaptor<UploadSession> saved = ArgumentCaptor.forClass(UploadSession.class);
        verify(uploads).save(saved.capture());
        UploadFile stored = saved.getValue().getFiles().getFirst();
        assertThat(stored.getMultipartUploadId()).isEqualTo("mp-1");
        assertThat(stored.getPartCount()).isEqualTo(3);
        String key = stored.getStorageKey();
        verify(storage).createMultipartUpload(key, "application/zip");
        verify(storage).presignUploadPart(key, "mp-1", 1, 32 * MB, Duration.ofHours(1));
        verify(storage).presignUploadPart(key, "mp-1", 3, 6 * MB, Duration.ofHours(1));
        verify(storage, never()).presignPut(anyString(), anyString(), anyLong());

        PresignedFile single = service.init(init("ct.zip", 64 * MB, "application/zip")).files().getFirst();
        assertThat(single.putUrl()).isNotNull();
        assertThat(single.multipart()).isNull();
    }

    @Test
    void completedImageIsProcessedInProcess() {
        UploadSession upload = stored("cxr.png", "image/png", new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});

        UploadDto dto = service.complete(upload.getId(), List.of());

        assertThat(dto.status()).isEqualTo("UPLOADED");
        assertThat(dto.inputType()).isEqualTo("IMAGE_2D");
        verify(events).publishEvent(new UploadCompleted(upload.getId()));
        verifyNoInteractions(ingest);
    }

    @Test
    void otherFilesAreDispatchedToTheIngestWorker() {
        UploadSession nifti = stored("ct.nii.gz", "application/x-gzip", TestFiles.gzip(TestFiles.nifti1()));
        UploadSession zip = stored("ct.zip", "application/zip", TestFiles.zip());
        UploadSession dicom = stored("cxr.dcm", "application/dicom", TestFiles.dicom());

        UploadDto niftiDto = service.complete(nifti.getId(), List.of());
        UploadDto zipDto = service.complete(zip.getId(), List.of());
        UploadDto dicomDto = service.complete(dicom.getId(), List.of());

        assertThat(niftiDto.inputType()).isEqualTo("NIFTI");
        assertThat(niftiDto.status()).isEqualTo("UPLOADED");
        assertThat(niftiDto.progress()).isZero();
        assertThat(niftiDto.studyId()).isNull();
        assertThat(zipDto.inputType()).isNull(); // the worker tells whether it is a DICOM series or a stack of images
        assertThat(zip.getIngestInput()).isEqualTo(IngestInput.ZIP);
        assertThat(zip.getReservedStudyId()).isNotNull();
        assertThat(dicomDto.inputType()).isEqualTo("DICOM_2D");
        assertThat(dicom.getIngestInput()).isEqualTo(IngestInput.DICOM_2D);
        verify(ingest).dispatch(nifti, NOW);
        verify(ingest).dispatch(zip, NOW);
        verify(ingest).dispatch(dicom, NOW);
        verify(events, never()).publishEvent(any());
    }

    @Test
    void contentThatDoesNotMatchItsDeclarationFailsAtOnce() {
        UploadSession upload = stored("ct.nii", "application/octet-stream", "plain text".getBytes(StandardCharsets.UTF_8));
        UploadSession zipAsDicom = stored("cxr.dcm", "application/dicom", TestFiles.zip());

        UploadDto dto = service.complete(upload.getId(), List.of());
        UploadDto dicomDto = service.complete(zipAsDicom.getId(), List.of());

        assertThat(dto.status()).isEqualTo("FAILED");
        assertThat(dto.error()).contains("not a NIfTI volume");
        assertThat(dto.inputType()).isNull();
        assertThat(dicomDto.error()).contains("not a DICOM file");
        verify(rawUploads).deleteAfterCommit(upload.getFiles().getFirst().getStorageKey());
        verifyNoInteractions(ingest, events);
    }

    @Test
    void completeChecksTheStoredObjectAndIsIdempotent() {
        UploadSession upload = stored("ct.nii", "application/octet-stream", TestFiles.nifti1());
        String key = upload.getFiles().getFirst().getStorageKey();

        when(storage.size(key)).thenThrow(new ObjectNotFoundException(key));
        assertConflict(upload.getId(), "has not been uploaded yet");
        doReturn(1L).when(storage).size(key);
        assertConflict(upload.getId(), "size mismatch");

        doReturn((long) TestFiles.nifti1().length).when(storage).size(key);
        service.complete(upload.getId(), List.of());
        service.complete(upload.getId(), List.of());
        verify(ingest).dispatch(eq(upload), any());
        assertThat(upload.getInputType()).isEqualTo(InputType.NIFTI);
    }

    @Test
    void partsAreAssembledBeforeTheObjectIsChecked() {
        UploadSession upload = storedInParts(3);
        UploadFile file = upload.getFiles().getFirst();

        UploadDto dto = service.complete(upload.getId(), List.of(new CompletedFile(file.getId(),
                List.of(part(3), part(1), part(2)))));

        assertThat(dto.status()).isEqualTo("UPLOADED");
        verify(storage).completeMultipartUpload(file.getStorageKey(), "mp-1", List.of(part(1), part(2), part(3)));
        verify(ingest).dispatch(upload, NOW);
    }

    @Test
    void partsMustBeListedForAFileUploadedInPartsOnlyAndAllOfThem() {
        UploadSession inParts = storedInParts(3);
        UUID fileId = inParts.getFiles().getFirst().getId();
        UploadSession single = stored("ct.nii", "application/octet-stream", TestFiles.nifti1());

        assertBadRequest(inParts.getId(), List.of(), "list its parts");
        assertBadRequest(inParts.getId(), List.of(new CompletedFile(fileId, List.of(part(1), part(2)))), "has 3 parts");
        assertBadRequest(inParts.getId(), List.of(new CompletedFile(fileId, List.of(part(1), part(2), part(2)))), "has 3 parts");
        assertBadRequest(inParts.getId(), List.of(new CompletedFile(fileId, List.of(part(1), part(2), part(4)))), "has 3 parts");
        assertBadRequest(inParts.getId(), List.of(new CompletedFile(UUID.randomUUID(), List.of(part(1)))), "not part of this upload");
        assertBadRequest(single.getId(), List.of(new CompletedFile(single.getFiles().getFirst().getId(), List.of(part(1)))),
                "not uploaded in parts");
        verify(storage, never()).completeMultipartUpload(anyString(), anyString(), any());
        assertThat(inParts.getStatus()).isEqualTo(UploadSession.Status.INIT);
    }

    @Test
    void partsRejectedByTheStorageFailTheUploadAndDropTheMultipartUpload() {
        UploadSession upload = storedInParts(1);
        UploadFile file = upload.getFiles().getFirst();
        doThrow(new MultipartUploadRejectedException(file.getStorageKey(), "InvalidPart"))
                .when(storage).completeMultipartUpload(anyString(), anyString(), any());

        UploadDto dto = service.complete(upload.getId(), List.of(new CompletedFile(file.getId(), List.of(part(1)))));

        assertThat(dto.status()).isEqualTo("FAILED");
        assertThat(dto.error()).isEqualTo(UploadService.PARTS_REJECTED);
        verify(rawUploads).abortMultipartAfterCommit(file.getStorageKey(), "mp-1");
        verifyNoInteractions(ingest);
    }

    @Test
    void uploadsOfOtherUsersAreNotFound() {
        UploadSession other = new UploadSession(UUID.randomUUID(), "CT", null, UUID.randomUUID(), NOW);
        when(uploads.findById(other.getId())).thenReturn(Optional.of(other));

        assertThatThrownBy(() -> service.get(other.getId()))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    private UploadSession stored(String name, String contentType, byte[] content) {
        UploadSession upload = new UploadSession(UUID.randomUUID(), "CT", null, USER, NOW);
        String key = upload.addFile(name, content.length, contentType).getStorageKey();
        when(uploads.findById(upload.getId())).thenReturn(Optional.of(upload));
        when(storage.size(key)).thenReturn((long) content.length);
        when(storage.getFirstBytes(key, FileTypeDetector.HEAD_BYTES)).thenReturn(content);
        return upload;
    }

    private UploadSession storedInParts(int partCount) {
        UploadSession upload = stored("ct.zip", "application/zip", TestFiles.zip());
        upload.getFiles().getFirst().uploadInParts("mp-1", partCount);
        return upload;
    }

    private static UploadedPart part(int n) {
        return new UploadedPart(n, "\"etag-" + n + "\"");
    }

    private static InitUpload init(String name, long size, String contentType) {
        return new InitUpload(UUID.randomUUID(), List.of(new FileSpec(name, size, contentType)), null, null, null);
    }

    private void assertBadRequest(InitUpload cmd, String detail) {
        assertThatThrownBy(() -> service.init(cmd)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(e.getMessage()).contains(detail);
        });
    }

    private void assertBadRequest(UUID uploadId, List<CompletedFile> files, String detail) {
        assertThatThrownBy(() -> service.complete(uploadId, files)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(e.getMessage()).contains(detail);
        });
    }

    private void assertConflict(UUID uploadId, String detail) {
        assertThatThrownBy(() -> service.complete(uploadId, List.of())).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(e.getMessage()).contains(detail);
        });
    }
}
