package com.medimg.imaging.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.medimg.imaging.domain.Study.InputType;
import com.medimg.imaging.domain.UploadSession.FailureOutcome;
import com.medimg.imaging.domain.UploadSession.Status;

class UploadSessionTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final UploadSession upload = new UploadSession(UUID.randomUUID(), "CT", null, UUID.randomUUID(), NOW);

    @Test
    void volumeUploadReservesTheIdsOfItsStudyAndSeries() {
        upload.markUploadedForIngest(InputType.DICOM_SERIES, NOW);

        assertThat(upload.getStatus()).isEqualTo(Status.UPLOADED);
        assertThat(upload.isVolume()).isTrue();
        assertThat(upload.getAttempt()).isEqualTo((short) 1);
        assertThat(upload.volumePrefix())
                .isEqualTo("studies/" + upload.getReservedStudyId() + "/series/" + upload.getReservedSeriesId() + "/");
        assertThat(upload.getStudyId()).isNull();
    }

    @Test
    void onlyVolumeTypesAreIngested() {
        assertThatThrownBy(() -> upload.markUploadedForIngest(InputType.IMAGE_2D, NOW))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void imageUploadIsA2dInput() {
        upload.markUploaded(NOW);

        assertThat(upload.getInputType()).isEqualTo(InputType.IMAGE_2D);
        assertThat(upload.isVolume()).isFalse();
        assertThat(upload.getReservedStudyId()).isNull();
    }

    @Test
    void progressStartsProcessingAndNeverGoesBackwards() {
        upload.markUploadedForIngest(InputType.NIFTI, NOW);

        upload.recordProgress(40, NOW.plusSeconds(5));
        upload.recordProgress(20, NOW.plusSeconds(6));
        upload.recordProgress(250, NOW.plusSeconds(7));

        assertThat(upload.getStatus()).isEqualTo(Status.PROCESSING);
        assertThat(upload.getProgress()).isEqualTo((short) 100);
        assertThat(upload.getUpdatedAt()).isEqualTo(NOW.plusSeconds(7));
    }

    @Test
    void retryableFailureStartsTheNextAttemptUntilTheLast() {
        upload.markUploadedForIngest(InputType.NIFTI, NOW);
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
        upload.markUploadedForIngest(InputType.NIFTI, NOW);

        assertThat(upload.failAttempt("Not a 3D volume", false, 3, NOW)).isEqualTo(FailureOutcome.FAILED);

        assertThat(upload.isTerminal()).isTrue();
        assertThat(upload.getAttempt()).isEqualTo((short) 1);
    }

    @Test
    void doneIsReachedFromAnyInProgressStateOnly() {
        upload.markUploadedForIngest(InputType.NIFTI, NOW);
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

        assertThatThrownBy(() -> upload.markUploadedForIngest(InputType.NIFTI, NOW)).isInstanceOf(IllegalStateException.class);
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
