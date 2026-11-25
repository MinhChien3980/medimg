package com.medimg.imaging.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
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

import com.medimg.imaging.application.ImagingDtos.FileSpec;
import com.medimg.imaging.application.ImagingDtos.InitUpload;
import com.medimg.imaging.application.ImagingDtos.UploadDto;
import com.medimg.imaging.application.UploadService.UploadCompleted;
import com.medimg.imaging.domain.Study.InputType;
import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.infrastructure.UploadSessionRepository;
import com.medimg.patient.application.PatientService;
import com.medimg.shared.storage.ObjectNotFoundException;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.storage.ObjectStoragePort.PresignedUrl;
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
            new ImagingProperties.Volume(500 * MB, Duration.ofMinutes(30), 3, List.of(Duration.ofSeconds(30))));
    private final UploadService service = new UploadService(uploads, mock(PatientService.class), storage, ingest,
            rawUploads, props, events, Clock.fixed(NOW, ZoneOffset.UTC));

    @BeforeEach
    void setUp() {
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "none").subject(USER.toString()).build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
        when(storage.presignPut(anyString(), anyString(), anyLong()))
                .thenReturn(new PresignedUrl(URI.create("http://s3/put"), NOW.plusSeconds(900)));
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void initSetsDefaultHintsAndSizeLimitByKind() {
        service.init(init("ct.nii.gz", 500 * MB, "application/gzip"));
        service.init(init("cxr.png", 50 * MB, "image/png"));

        ArgumentCaptor<UploadSession> saved = ArgumentCaptor.forClass(UploadSession.class);
        verify(uploads, times(2)).save(saved.capture());
        assertThat(saved.getAllValues().get(0).getModalityHint()).isEqualTo("CT");
        assertThat(saved.getAllValues().get(0).getBodyPartHint()).isNull();
        assertThat(saved.getAllValues().get(1).getModalityHint()).isEqualTo("CR");
        assertThat(saved.getAllValues().get(1).getBodyPartHint()).isEqualTo("CHEST");

        assertBadRequest(init("ct.nii", 500 * MB + 1, "application/octet-stream"), "500 MB");
        assertBadRequest(init("cxr.jpg", 50 * MB + 1, "image/jpeg"), "50 MB");
        assertBadRequest(init("series.zip", 0, "application/zip"), "between 1 byte");
        assertBadRequest(init("scan.dcm", 10, "application/dicom"), "Unsupported file");
        assertBadRequest(init("ct.nii.gz.zip", 10, "application/gzip"), "Unsupported file");
    }

    @Test
    void completedImageIsProcessedInProcess() {
        UploadSession upload = stored("cxr.png", "image/png", new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});

        UploadDto dto = service.complete(upload.getId());

        assertThat(dto.status()).isEqualTo("UPLOADED");
        assertThat(dto.inputType()).isEqualTo("IMAGE_2D");
        verify(events).publishEvent(new UploadCompleted(upload.getId()));
        verifyNoInteractions(ingest);
    }

    @Test
    void completedVolumeIsDispatchedToTheIngestWorker() {
        UploadSession nifti = stored("ct.nii.gz", "application/x-gzip", TestFiles.gzip(TestFiles.nifti1()));
        UploadSession dicom = stored("ct.zip", "application/zip", TestFiles.zip());

        UploadDto niftiDto = service.complete(nifti.getId());
        UploadDto dicomDto = service.complete(dicom.getId());

        assertThat(niftiDto.inputType()).isEqualTo("NIFTI");
        assertThat(niftiDto.status()).isEqualTo("UPLOADED");
        assertThat(niftiDto.progress()).isZero();
        assertThat(niftiDto.studyId()).isNull();
        assertThat(dicomDto.inputType()).isEqualTo("DICOM_SERIES");
        assertThat(dicom.getReservedStudyId()).isNotNull();
        verify(ingest).dispatch(nifti, NOW);
        verify(ingest).dispatch(dicom, NOW);
        verify(events, never()).publishEvent(any());
    }

    @Test
    void contentThatDoesNotMatchItsDeclarationFailsAtOnce() {
        UploadSession upload = stored("ct.nii", "application/octet-stream", "plain text".getBytes(StandardCharsets.UTF_8));

        UploadDto dto = service.complete(upload.getId());

        assertThat(dto.status()).isEqualTo("FAILED");
        assertThat(dto.error()).contains("neither a ZIP archive");
        assertThat(dto.inputType()).isNull();
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
        service.complete(upload.getId());
        service.complete(upload.getId());
        verify(ingest).dispatch(eq(upload), any());
        assertThat(upload.getInputType()).isEqualTo(InputType.NIFTI);
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

    private static InitUpload init(String name, long size, String contentType) {
        return new InitUpload(UUID.randomUUID(), List.of(new FileSpec(name, size, contentType)), null, null);
    }

    private void assertBadRequest(InitUpload cmd, String detail) {
        assertThatThrownBy(() -> service.init(cmd)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(e.getMessage()).contains(detail);
        });
    }

    private void assertConflict(UUID uploadId, String detail) {
        assertThatThrownBy(() -> service.complete(uploadId)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(e.getMessage()).contains(detail);
        });
    }
}
