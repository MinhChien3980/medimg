package com.medimg.prediction.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
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

import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;

import com.medimg.imaging.application.StudyService;
import com.medimg.prediction.application.WorkerResult.Type;
import com.medimg.prediction.domain.JobStatus;
import com.medimg.prediction.domain.PredictionJob;
import com.medimg.prediction.infrastructure.FindingRepository;
import com.medimg.prediction.infrastructure.PredictionJobRepository;
import com.medimg.prediction.infrastructure.PredictionResultRepository;
import com.medimg.shared.storage.ObjectStoragePort;

import tools.jackson.databind.json.JsonMapper;

class ResultHandlerTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final PredictionJobRepository jobs = mock(PredictionJobRepository.class);
    private final PredictionResultRepository results = mock(PredictionResultRepository.class);
    private final JobOutbox outbox = mock(JobOutbox.class);
    private final StudyService studies = mock(StudyService.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final PredictionProperties props = new PredictionProperties(3,
            List.of(Duration.ofSeconds(30), Duration.ofMinutes(2)), Duration.ofMinutes(2), Duration.ofMinutes(20),
            Duration.ofMinutes(30), Duration.ofSeconds(15), Duration.ofMinutes(30));
    private final ResultHandler handler = new ResultHandler(jobs, results, mock(FindingRepository.class), outbox, studies,
            mock(ObjectStoragePort.class), props, JsonMapper.builder().build(), events, Clock.fixed(NOW, ZoneOffset.UTC));

    private final PredictionJob job = new PredictionJob(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), "{}",
            null, UUID.randomUUID(), NOW.minusSeconds(60));

    ResultHandlerTest() {
        when(jobs.findById(job.getId())).thenReturn(Optional.of(job));
        when(studies.exists(job.getStudyId())).thenReturn(true);
    }

    @Test
    void retryableFailureDispatchesTheNextAttemptAfterTheBackoff() {
        handler.handle(result(1, Type.STARTED, null, false));

        handler.handle(result(1, Type.FAILED, "S3 timeout", true));

        assertThat(job.getStatus()).isEqualTo(JobStatus.QUEUED);
        assertThat(job.getAttempt()).isEqualTo((short) 2);
        verify(outbox).dispatch(job, NOW.plusSeconds(30));
    }

    @Test
    void duplicateFailureOfTheSameAttemptDoesNotDispatchAgain() {
        handler.handle(result(1, Type.FAILED, "S3 timeout", true));
        handler.handle(result(1, Type.FAILED, "S3 timeout", true));

        assertThat(job.getAttempt()).isEqualTo((short) 2);
        verify(outbox, times(1)).dispatch(any(), any());
    }

    @Test
    void secondRetryWaitsForTheSecondBackoff() {
        handler.handle(result(1, Type.FAILED, "S3 timeout", true));
        handler.handle(result(2, Type.FAILED, "S3 timeout", true));

        assertThat(job.getAttempt()).isEqualTo((short) 3);
        verify(outbox).dispatch(job, NOW.plus(Duration.ofMinutes(2)));
    }

    @Test
    void resultsForAFinishedJobAreIgnored() {
        job.cancel(NOW);

        handler.handle(result(1, Type.DONE, null, false));
        handler.handle(result(1, Type.FAILED, "late", true));
        handler.handle(result(0, Type.FAILED, "unreadable", false));

        assertThat(job.getStatus()).isEqualTo(JobStatus.CANCELLED);
        verifyNoInteractions(outbox, results, events);
    }

    @Test
    void jobOfADeletedCaseIsNotRetried() {
        when(studies.exists(job.getStudyId())).thenReturn(false);

        handler.handle(result(1, Type.FAILED, "S3 timeout", true));

        assertThat(job.getStatus()).isEqualTo(JobStatus.FAILED);
        verify(outbox, never()).dispatch(any(), any());
    }

    @Test
    void rejectedJobMessageFailsTheJobAndDropsItsPendingDispatch() {
        handler.handle(result(1, Type.FAILED, "S3 timeout", true)); // attempt 2 now waits for its backoff

        handler.handle(result(0, Type.FAILED, "attempt is not an integer", false));

        assertThat(job.getStatus()).isEqualTo(JobStatus.FAILED);
        verify(outbox).discardPending(job.getId());
    }

    @Test
    void watchdogTimeoutIsARetryableFailure() {
        handler.handle(result(1, Type.STARTED, null, false));

        handler.timeout(job, "Worker did not finish within 2 min");

        assertThat(job.getAttempt()).isEqualTo((short) 2);
        assertThat(job.getErrorMessage()).contains("did not finish");
        verify(outbox).dispatch(job, NOW.plusSeconds(30));
    }

    private WorkerResult result(int attempt, Type type, String error, boolean retryable) {
        return new WorkerResult(job.getId(), attempt, "w1", type, 0, null, error, retryable);
    }
}
