package com.medimg.prediction.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.prediction.domain.AiModel;
import com.medimg.prediction.domain.JobStatus;
import com.medimg.prediction.domain.PredictionJob;
import com.medimg.prediction.infrastructure.AiModelRepository;
import com.medimg.prediction.infrastructure.PredictionJobRepository;

class JobWatchdogTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final PredictionJobRepository jobs = mock(PredictionJobRepository.class);
    private final AiModelRepository models = mock(AiModelRepository.class);
    private final JobOutbox outbox = mock(JobOutbox.class);
    private final ResultHandler results = mock(ResultHandler.class);
    private final PredictionProperties props = new PredictionProperties(3, List.of(Duration.ofSeconds(30)),
            Duration.ofMinutes(2), Duration.ofMinutes(20), Duration.ofMinutes(30), Duration.ofSeconds(15),
            Duration.ofMinutes(30));
    private final JobWatchdog watchdog = new JobWatchdog(jobs, models, outbox, results, props,
            new TransactionTemplate(mock(PlatformTransactionManager.class)), mock(ApplicationEventPublisher.class),
            Clock.fixed(NOW, ZoneOffset.UTC));

    @Test
    void jobNoWorkerTookFailsAndLosesItsUnpublishedDispatch() {
        PredictionJob job = job(NOW.minus(Duration.ofMinutes(31)));
        when(jobs.findByStatusAndQueuedAtBefore(eq(JobStatus.QUEUED), any())).thenReturn(List.of(job));

        watchdog.watchdog();

        assertThat(job.getStatus()).isEqualTo(JobStatus.FAILED);
        assertThat(job.getErrorMessage()).contains("No AI worker");
        verify(outbox).discardPending(job.getId());
    }

    @Test
    void silentWorkerTimesOutAfterTheTimeoutOfItsModel() {
        PredictionJob slow2d = running(Duration.ofMinutes(3), false);
        PredictionJob running3d = running(Duration.ofMinutes(3), true);
        when(jobs.findByStatusAndStartedAtBefore(eq(JobStatus.RUNNING), any())).thenReturn(List.of(slow2d, running3d));

        watchdog.watchdog();

        verify(results).timeout(eq(slow2d), anyString());
        verify(results, never()).timeout(eq(running3d), anyString());
    }

    private PredictionJob job(Instant queuedAt) {
        PredictionJob job = new PredictionJob(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), "{}", null,
                UUID.randomUUID(), queuedAt);
        when(jobs.findById(job.getId())).thenReturn(Optional.of(job));
        return job;
    }

    private PredictionJob running(Duration since, boolean model3d) {
        PredictionJob job = job(NOW.minus(since));
        job.markRunning("w1", NOW.minus(since));
        AiModel model = mock(AiModel.class);
        when(model.is3d()).thenReturn(model3d);
        when(models.findById(job.getModelId())).thenReturn(Optional.of(model));
        return job;
    }
}
