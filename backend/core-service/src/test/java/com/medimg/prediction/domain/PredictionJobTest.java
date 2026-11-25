package com.medimg.prediction.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.medimg.prediction.domain.PredictionJob.FailureOutcome;

class PredictionJobTest {

    private static final Instant T0 = Instant.parse("2026-11-25T00:00:00Z");

    private PredictionJob newJob() {
        return new PredictionJob(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), "{}", null, UUID.randomUUID(), T0);
    }

    @Test
    void happyPath() {
        PredictionJob job = newJob();
        assertThat(job.getStatus()).isEqualTo(JobStatus.QUEUED);
        assertThat(job.getAttempt()).isEqualTo((short) 1);

        job.markRunning("w1", T0.plusSeconds(1));
        job.updateProgress(40, T0.plusSeconds(2));
        job.complete(T0.plusSeconds(3));

        assertThat(job.getStatus()).isEqualTo(JobStatus.DONE);
        assertThat(job.getProgress()).isEqualTo((short) 100);
        assertThat(job.getStartedAt()).isEqualTo(T0.plusSeconds(1));
        assertThat(job.getFinishedAt()).isEqualTo(T0.plusSeconds(3));
    }

    @Test
    void progressNeverGoesBackwardsAndIsClamped() {
        PredictionJob job = newJob();
        job.updateProgress(60, T0);
        job.updateProgress(30, T0);
        assertThat(job.getProgress()).isEqualTo((short) 60);
        job.updateProgress(500, T0);
        assertThat(job.getProgress()).isEqualTo((short) 100);
        assertThat(job.getStatus()).isEqualTo(JobStatus.RUNNING);
        assertThat(job.getStartedAt()).isEqualTo(T0);
    }

    @Test
    void retryableFailureStartsTheNextAttemptUntilMaxAttempts() {
        PredictionJob job = newJob();
        job.markRunning("w1", T0);
        job.updateProgress(40, T0);

        assertThat(job.fail("boom", true, 3, T0.plusSeconds(5))).isEqualTo(FailureOutcome.RETRY_SCHEDULED);
        assertThat(job.getStatus()).isEqualTo(JobStatus.QUEUED);
        assertThat(job.getAttempt()).isEqualTo((short) 2);
        assertThat(job.getProgress()).isZero();
        assertThat(job.getQueuedAt()).isEqualTo(T0.plusSeconds(5));
        assertThat(job.getStartedAt()).isNull();
        assertThat(job.getWorkerId()).isNull();
        assertThat(job.getErrorMessage()).isEqualTo("boom");

        assertThat(job.fail("boom", true, 3, T0)).isEqualTo(FailureOutcome.RETRY_SCHEDULED);
        assertThat(job.getAttempt()).isEqualTo((short) 3);

        assertThat(job.fail("boom", true, 3, T0)).isEqualTo(FailureOutcome.FAILED);
        assertThat(job.getStatus()).isEqualTo(JobStatus.FAILED);
        assertThat(job.getAttempt()).isEqualTo((short) 3);
        assertThat(job.getErrorMessage()).isEqualTo("boom");
    }

    @Test
    void nonRetryableFailureIsFinal() {
        PredictionJob job = newJob();
        assertThat(job.fail("bad image", false, 3, T0)).isEqualTo(FailureOutcome.FAILED);
        assertThat(job.getStatus()).isEqualTo(JobStatus.FAILED);
    }

    @Test
    void messagesFromOlderAttemptsAreNotAccepted() {
        PredictionJob job = newJob();
        job.fail("boom", true, 3, T0);
        assertThat(job.accepts(1)).isFalse(); // a duplicate FAILED of attempt 1 does not schedule another retry
        assertThat(job.accepts(2)).isTrue();
        job.complete(T0);
        assertThat(job.accepts(2)).isFalse(); // terminal
    }

    @Test
    void cancelAndManualRetry() {
        PredictionJob job = newJob();
        job.cancel(T0);
        assertThat(job.getStatus()).isEqualTo(JobStatus.CANCELLED);
        assertThatThrownBy(() -> job.cancel(T0)).isInstanceOf(IllegalStateException.class);

        job.manualRetry(T0.plusSeconds(5));
        assertThat(job.getStatus()).isEqualTo(JobStatus.QUEUED);
        assertThat(job.getAttempt()).isEqualTo((short) 2);
        assertThat(job.getFinishedAt()).isNull();
    }

    @Test
    void cannotRetryRunningJobOrCompleteTwice() {
        PredictionJob job = newJob();
        job.markRunning("w", T0);
        assertThatThrownBy(() -> job.manualRetry(T0)).isInstanceOf(IllegalStateException.class);
        job.complete(T0);
        assertThatThrownBy(() -> job.complete(T0)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> job.fail("late", true, 3, T0)).isInstanceOf(IllegalStateException.class);
    }
}
