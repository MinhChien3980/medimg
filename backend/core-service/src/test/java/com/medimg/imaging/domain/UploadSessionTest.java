package com.medimg.imaging.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.medimg.imaging.domain.Study.InputType;
import com.medimg.imaging.domain.UploadSession.FailureOutcome;
import com.medimg.imaging.domain.UploadSession.Status;

class UploadSessionTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final UploadSession upload = new UploadSession(UUID.randomUUID(), "CT", null, UUID.randomUUID(), NOW);

    @Test
    void ingestedUploadReservesTheIdsOfItsStudyAndSeries() {
        upload.markUploadedForIngest(IngestInput.ZIP, NOW);

        assertThat(upload.getStatus()).isEqualTo(Status.UPLOADED);
        assertThat(upload.isIngested()).isTrue();
        assertThat(upload.getAttempt()).isEqualTo((short) 1);
        assertThat(upload.outputPrefix())
                .isEqualTo("studies/" + upload.getReservedStudyId() + "/series/" + upload.getReservedSeriesId() + "/");
        assertThat(upload.getStudyId()).isNull();
    }

    @Test
    void inputTypeIsKnownAtCompleteUnlessTheWorkerDecides() {
        UploadSession dicom = new UploadSession(UUID.randomUUID(), "CR", "CHEST", UUID.randomUUID(), NOW);
        dicom.markUploadedForIngest(IngestInput.DICOM_2D, NOW);
        upload.markUploadedForIngest(IngestInput.ZIP, NOW);

        assertThat(dicom.getInputType()).isEqualTo(InputType.DICOM_2D);
        assertThat(upload.getInputType()).isNull();
    }

    @Test
    void ingestedUploadBecomesWhatItsInputCanBecome() {
        upload.markUploadedForIngest(IngestInput.ZIP, NOW);

        assertThatThrownBy(() -> upload.markIngested(InputType.NIFTI, NOW)).isInstanceOf(IllegalArgumentException.class);
        upload.markIngested(InputType.IMAGE_STACK, NOW);

        assertThat(upload.getStatus()).isEqualTo(Status.DONE);
        assertThat(upload.getInputType()).isEqualTo(InputType.IMAGE_STACK);
        assertThat(upload.getStudyId()).isEqualTo(upload.getReservedStudyId());
    }

    @Test
    void requestedSpacingIsThreeValues() {
        assertThat(upload.requestedSpacing()).isNull();
        assertThatThrownBy(() -> upload.requestSpacing(List.of(1.0, 1.0))).isInstanceOf(IllegalArgumentException.class);

        upload.requestSpacing(List.of(0.5, 0.5, 2.0));

        assertThat(upload.requestedSpacing()).containsExactly(0.5, 0.5, 2.0);
    }

    @Test
    void fileUploadedInPartsHasAtLeastOnePart() {
        UploadFile file = upload.addFile("ct.zip", 100, "application/zip");
        assertThat(file.isMultipart()).isFalse();
        assertThatThrownBy(() -> file.uploadInParts("mp-1", 0)).isInstanceOf(IllegalArgumentException.class);

        file.uploadInParts("mp-1", 3);

        assertThat(file.isMultipart()).isTrue();
        assertThat(file.getPartCount()).isEqualTo(3);
    }

    @Test
    void imageUploadIsA2dInput() {
        upload.markUploaded(NOW);

        assertThat(upload.getInputType()).isEqualTo(InputType.IMAGE_2D);
        assertThat(upload.isIngested()).isFalse();
        assertThat(upload.getReservedStudyId()).isNull();
    }

    @Test
    void progressStartsProcessingAndNeverGoesBackwards() {
        upload.markUploadedForIngest(IngestInput.NIFTI, NOW);

        upload.recordProgress(40, NOW.plusSeconds(5));
        upload.recordProgress(20, NOW.plusSeconds(6));
        upload.recordProgress(250, NOW.plusSeconds(7));

        assertThat(upload.getStatus()).isEqualTo(Status.PROCESSING);
        assertThat(upload.getProgress()).isEqualTo((short) 100);
        assertThat(upload.getUpdatedAt()).isEqualTo(NOW.plusSeconds(7));
    }

    @Test
    void retryableFailureStartsTheNextAttemptUntilTheLast() {
        upload.markUploadedForIngest(IngestInput.NIFTI, NOW);
        upload.recordProgress(30, NOW);

        assertThat(upload.failAttempt("S3 timeout", true, 3, NOW)).isEqualTo(FailureOutcome.RETRY_SCHEDULED);
        assertThat(upload.getStatus()).isEqualTo(Status.UPLOADED);
        assertThat(upload.getAttempt()).isEqualTo((short) 2);
        assertThat(upload.getProgress()).isZero();
        assertThat(upload.accepts(1)).isFalse();
        assertThat(upload.accepts(2)).isTrue();

        upload.failAttempt("S3 timeout", true, 3, NOW);
        assertThat(upload.failAttempt("S3 timeout", true, 3, NOW)).isEqualTo(FailureOutcome.FAILED);
        assertThat(upload.getStatus()).isEqualTo(Status.FAILED);
        assertThat(upload.getError()).isEqualTo("S3 timeout");
        assertThat(upload.accepts(3)).isFalse();
    }

    @Test
    void permanentFailureEndsTheUpload() {
        upload.markUploadedForIngest(IngestInput.NIFTI, NOW);

        assertThat(upload.failAttempt("Not a 3D volume", false, 3, NOW)).isEqualTo(FailureOutcome.FAILED);

        assertThat(upload.isTerminal()).isTrue();
        assertThat(upload.getAttempt()).isEqualTo((short) 1);
    }

    @Test
    void doneIsReachedFromAnyInProgressStateOnly() {
        upload.markUploadedForIngest(IngestInput.NIFTI, NOW);
        UUID studyId = upload.getReservedStudyId();

        upload.markDone(studyId, NOW);

        assertThat(upload.getStudyId()).isEqualTo(studyId);
        assertThat(upload.getProgress()).isEqualTo((short) 100);
        assertThatThrownBy(() -> upload.markDone(studyId, NOW)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> upload.recordProgress(10, NOW)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void completeOnlyOnce() {
        upload.markUploaded(NOW);

        assertThatThrownBy(() -> upload.markUploadedForIngest(IngestInput.NIFTI, NOW)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void storageKeysUseASafeFileName() {
        assertThat(upload.addFile("../../my scan.nii.gz", 10, "application/gzip").getStorageKey())
                .isEqualTo("uploads/" + upload.getId() + "/" + upload.getFiles().getFirst().getId() + "/my_scan.nii.gz");
        assertThat(UploadSession.safeName(".hidden")).isEqualTo("file.hidden");
    }

    @Test
    void volumeInputsAreNormalisedToNifti() {
        assertThat(InputType.DICOM_SERIES.normalized()).isEqualTo(InputType.NIFTI);
        assertThat(InputType.NIFTI.normalized()).isEqualTo(InputType.NIFTI);
        assertThat(InputType.IMAGE_2D.normalized()).isEqualTo(InputType.IMAGE_2D);
        assertThat(InputType.DICOM_2D.isVolume()).isFalse();
    }
}
