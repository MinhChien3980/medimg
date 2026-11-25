package com.medimg.prediction.application;

import java.time.Clock;
import java.time.Instant;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.prediction.application.PredictionDtos.PredictionChanged;
import com.medimg.prediction.domain.AiModel;
import com.medimg.prediction.domain.JobStatus;
import com.medimg.prediction.domain.PredictionJob;
import com.medimg.prediction.infrastructure.AiModelRepository;
import com.medimg.prediction.infrastructure.PredictionJobRepository;

/**
 * Fails jobs whose worker went silent: RUNNING too long → retryable failure (the retry is dispatched through the
 * outbox); QUEUED too long (no worker took it) → failure, and a dispatch that was never published is dropped.
 */
@Component
class JobWatchdog {

    private static final Logger log = LoggerFactory.getLogger(JobWatchdog.class);

    private final PredictionJobRepository jobs;
    private final AiModelRepository models;
    private final JobOutbox outbox;
    private final ResultHandler results;
    private final PredictionProperties props;
    private final TransactionTemplate tx;
    private final ApplicationEventPublisher events;
    private final Clock clock;

    JobWatchdog(PredictionJobRepository jobs, AiModelRepository models, JobOutbox outbox, ResultHandler results,
                PredictionProperties props, TransactionTemplate tx, ApplicationEventPublisher events, Clock clock) {
        this.jobs = jobs;
        this.models = models;
        this.outbox = outbox;
        this.results = results;
        this.props = props;
        this.tx = tx;
        this.events = events;
        this.clock = clock;
    }

    @Scheduled(fixedDelay = 30_000, initialDelay = 30_000)
    void watchdog() {
        Instant now = clock.instant();
        for (PredictionJob job : jobs.findByStatusAndStartedAtBefore(JobStatus.RUNNING, now.minus(props.timeout2d()))) {
            AiModel model = models.findById(job.getModelId()).orElse(null);
            var timeout = model != null && model.is3d() ? props.timeout3d() : props.timeout2d();
            if (job.getStartedAt().isBefore(now.minus(timeout))) {
                log.warn("Job {} attempt {} exceeded {} on worker {}", job.getId(), job.getAttempt(), timeout, job.getWorkerId());
                results.timeout(job, "Worker did not finish within " + timeout.toMinutes() + " min");
            }
        }
        for (PredictionJob job : jobs.findByStatusAndQueuedAtBefore(JobStatus.QUEUED, now.minus(props.queuedTimeout()))) {
            tx.executeWithoutResult(s -> jobs.findById(job.getId())
                    .filter(j -> j.getStatus() == JobStatus.QUEUED && j.getAttempt() == job.getAttempt())
                    .ifPresent(j -> {
                        j.fail("No AI worker picked up the job within " + props.queuedTimeout().toMinutes() + " min",
                                false, props.maxAttempts(), now);
                        outbox.discardPending(j.getId());
                        events.publishEvent(new PredictionChanged(j.getId(), j.getStatus().name(), j.getProgress()));
                    }));
        }
    }
}
