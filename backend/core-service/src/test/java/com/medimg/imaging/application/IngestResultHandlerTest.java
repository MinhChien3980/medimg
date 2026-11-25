package com.medimg.imaging.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import com.medimg.imaging.application.IngestResult.Type;
import com.medimg.imaging.domain.Series;
import com.medimg.imaging.domain.Study;
import com.medimg.imaging.domain.Study.InputType;
import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.domain.UploadSession.Status;
import com.medimg.imaging.infrastructure.SeriesRepository;
import com.medimg.imaging.infrastructure.StudyRepository;
import com.medimg.imaging.infrastructure.UploadSessionRepository;
import com.medimg.patient.application.PatientService;
import com.medimg.shared.storage.ObjectStoragePort;

import tools.jackson.databind.json.JsonMapper;

class IngestResultHandlerTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final UploadSessionRepository uploads = mock(UploadSessionRepository.class);
    private final StudyRepository studies = mock(StudyRepository.class);
    private final SeriesRepository series = mock(SeriesRepository.class);
    private final IngestDispatcher dispatcher = mock(IngestDispatcher.class);
    private final PatientService patients = mock(PatientService.class);
    private final RawUploads rawUploads = mock(RawUploads.class);
    private final ObjectStoragePort storage = mock(ObjectStoragePort.class);
    private final ImagingProperties props = new ImagingProperties(50_000_000, 256, Duration.ofMinutes(10),
            new ImagingProperties.Volume(500_000_000, Duration.ofMinutes(30), 3,
                    List.of(Duration.ofSeconds(30), Duration.ofMinutes(2))));
    private final IngestResultHandler handler = new IngestResultHandler(uploads, studies, series, dispatcher, patients,
            rawUploads, storage, props, JsonMapper.builder().build(), Clock.fixed(NOW, ZoneOffset.UTC));

    private final UploadSession upload = new UploadSession(UUID.randomUUID(), "CT", "ABDOMEN", UUID.randomUUID(),
            NOW.minusSeconds(60));
    private final String rawKey;

    IngestResultHandlerTest() {
        rawKey = upload.addFile("ct.zip", 100, "application/zip").getStorageKey();
        upload.markUploadedForIngest(InputType.DICOM_SERIES, NOW.minusSeconds(60));
        when(uploads.findById(upload.getId())).thenReturn(Optional.of(upload));
        when(patients.exists(upload.getPatientId())).thenReturn(true);
        when(storage.keyOf(anyString())).thenAnswer(i -> i.<String>getArgument(0).substring("s3://medimg/".length()));
        when(studies.save(any(Study.class))).thenAnswer(i -> i.getArgument(0));
    }

    @Test
    void doneCreatesTheStudyAndSeriesUnderTheReservedIds() {
        handler.handle(result(1, Type.STARTED, null, null, false));
        handler.handle(result(1, Type.DONE, payload(upload.volumePrefix(), "\"ct\""), null, false));

        ArgumentCaptor<Study> study = ArgumentCaptor.forClass(Study.class);
        verify(studies).save(study.capture());
        assertThat(study.getValue().getId()).isEqualTo(upload.getReservedStudyId());
        assertThat(study.getValue().getInputType()).isEqualTo(InputType.DICOM_SERIES);
        assertThat(study.getValue().getModality()).isEqualTo("CT");
        assertThat(study.getValue().getBodyPart()).isEqualTo("ABDOMEN");
        assertThat(study.getValue().getCreatedBy()).isEqualTo(upload.getCreatedBy());
        ArgumentCaptor<Series> saved = ArgumentCaptor.forClass(Series.class);
        verify(series).save(saved.capture());
        Series s = saved.getValue();
        assertThat(s.getId()).isEqualTo(upload.getReservedSeriesId());
        assertThat(s.getImageKey()).isEqualTo(upload.volumePrefix() + "volume.nii.gz");
        assertThat(s.getThumbnailKey()).isEqualTo(upload.volumePrefix() + "thumb.png");
        assertThat(s.dims()).containsExactly(512, 400, 120);
        assertThat(s.getCols()).isEqualTo(512);
        assertThat(s.getRows()).isEqualTo(400);
        assertThat(s.getNumImages()).isEqualTo(120);
        assertThat(s.spacing()).containsExactly(0.7, 0.7, 2.5);
        assertThat(upload.getStatus()).isEqualTo(Status.DONE);
        assertThat(upload.getStudyId()).isEqualTo(upload.getReservedStudyId());
        verify(rawUploads).deleteAfterCommit(rawKey);
    }

    @Test
    void modalityFallsBackToTheHint() {
        handler.handle(result(1, Type.DONE, payload(upload.volumePrefix(), "null"), null, false));

        ArgumentCaptor<Study> study = ArgumentCaptor.forClass(Study.class);
        verify(studies).save(study.capture());
        assertThat(study.getValue().getModality()).isEqualTo("CT");
    }

    @Test
    void retryableFailureDispatchesTheNextAttemptAfterTheBackoff() {
        handler.handle(result(1, Type.FAILED, null, "S3 timeout", true));

        assertThat(upload.getAttempt()).isEqualTo((short) 2);
        assertThat(upload.getStatus()).isEqualTo(Status.UPLOADED);
        verify(dispatcher).dispatch(upload, NOW.plusSeconds(30));
        verifyNoInteractions(rawUploads);

        handler.handle(result(1, Type.FAILED, null, "S3 timeout", true)); // duplicate of attempt 1
        handler.handle(result(2, Type.FAILED, null, "S3 timeout", true));
        verify(dispatcher).dispatch(upload, NOW.plus(Duration.ofMinutes(2)));
        verify(dispatcher, times(2)).dispatch(any(), any());
    }

    @Test
    void lastAttemptFailsTheUploadWithTheWorkerMessage() {
        handler.handle(result(1, Type.FAILED, null, "S3 timeout", true));
        handler.handle(result(2, Type.FAILED, null, "S3 timeout", true));

        handler.handle(result(3, Type.FAILED, null, "S3 timeout", true));

        assertThat(upload.getStatus()).isEqualTo(Status.FAILED);
        assertThat(upload.getError()).isEqualTo("S3 timeout");
        verify(rawUploads).deleteAfterCommit(rawKey);
    }

    @Test
    void failureWithoutMessageGetsAGenericOne() {
        handler.handle(result(1, Type.FAILED, null, " ", false));

        assertThat(upload.getError()).isEqualTo("Processing failed, please upload the file again");
    }

    @Test
    void uploadOfADeletedCaseIsNotRetried() {
        when(patients.exists(upload.getPatientId())).thenReturn(false);

        handler.handle(result(1, Type.FAILED, null, "S3 timeout", true));

        assertThat(upload.getStatus()).isEqualTo(Status.FAILED);
        verify(dispatcher, never()).dispatch(any(), any());
    }

    @Test
    void messagesOfAnotherAttemptOrAFinishedUploadAreIgnored() {
        handler.handle(result(2, Type.PROGRESS, null, null, false));
        assertThat(upload.getProgress()).isZero();

        handler.handle(result(1, Type.FAILED, null, "bad data", false));
        handler.handle(result(1, Type.DONE, payload(upload.volumePrefix(), "\"CT\""), null, false));
        handler.handle(result(0, Type.FAILED, null, "unreadable", false));

        assertThat(upload.getStatus()).isEqualTo(Status.FAILED);
        assertThat(upload.getError()).isEqualTo("bad data");
        verifyNoInteractions(studies, series);
        verify(dispatcher, never()).discardPending(any());
    }

    @Test
    void rejectedJobMessageFailsTheUploadAndDropsItsPendingDispatch() {
        handler.handle(result(1, Type.FAILED, null, "S3 timeout", true)); // attempt 2 now waits for its backoff

        handler.handle(result(0, Type.FAILED, null, "attempt is not an integer", false));

        assertThat(upload.getStatus()).isEqualTo(Status.FAILED);
        assertThat(upload.getError()).isEqualTo("attempt is not an integer");
        verify(dispatcher).discardPending(upload.getId());
    }

    @Test
    void unreadableDonePayloadFailsTheUploadForGood() {
        assertUnreadable(u -> payload("studies/" + UUID.randomUUID() + "/series/" + UUID.randomUUID() + "/", "\"CT\""));
        assertUnreadable(u -> """
                {"volumeUri":"s3://medimg/%1$svolume.nii.gz","thumbnailUri":"s3://medimg/%1$sthumb.png",
                 "dims":[512,512],"spacing":[1,1,1]}
                """.formatted(u.volumePrefix()));
        assertUnreadable(u -> payload(u.volumePrefix(), "\"CT\"").replace("0.7,0.7,2.5", "0.7,0,2.5"));
        assertUnreadable(u -> "{not json");
        assertUnreadable(u -> null);
        verifyNoInteractions(studies, series);
    }

    @Test
    void resultsForUnknownOr2dUploadsAreIgnored() {
        UploadSession image = new UploadSession(UUID.randomUUID(), "CR", "CHEST", UUID.randomUUID(), NOW);
        image.markUploaded(NOW);
        when(uploads.findById(image.getId())).thenReturn(Optional.of(image));

        handler.handle(new IngestResult(UUID.randomUUID(), 1, "w1", Type.STARTED, 0, null, null, false));
        handler.handle(new IngestResult(image.getId(), 1, "w1", Type.FAILED, 0, null, "x", false));

        assertThat(image.getStatus()).isEqualTo(Status.UPLOADED);
    }

    private void assertUnreadable(Function<UploadSession, String> payload) {
        UploadSession u = new UploadSession(UUID.randomUUID(), "CT", null, UUID.randomUUID(), NOW);
        u.addFile("ct.nii", 10, "application/octet-stream");
        u.markUploadedForIngest(InputType.NIFTI, NOW);
        when(uploads.findById(u.getId())).thenReturn(Optional.of(u));

        handler.handle(new IngestResult(u.getId(), 1, "w1", Type.DONE, 0, payload.apply(u), null, false));

        assertThat(u.getStatus()).isEqualTo(Status.FAILED);
        assertThat(u.getError()).isEqualTo(IngestResultHandler.UNREADABLE_RESULT);
    }

    private IngestResult result(int attempt, Type type, String payload, String error, boolean retryable) {
        return new IngestResult(upload.getId(), attempt, "w1", type, 0, payload, error, retryable);
    }

    private static String payload(String prefix, String modalityJson) {
        return """
                {"volumeUri":"s3://medimg/%1$svolume.nii.gz","thumbnailUri":"s3://medimg/%1$sthumb.png",
                 "modality":%2$s,"dims":[512,400,120],"spacing":[0.7,0.7,2.5],"numSlices":120}
                """.formatted(prefix, modalityJson);
    }
}
