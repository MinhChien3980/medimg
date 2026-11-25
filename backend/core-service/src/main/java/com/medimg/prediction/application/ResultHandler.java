package com.medimg.prediction.application;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.StudyService;
import com.medimg.prediction.application.PredictionDtos.PredictionChanged;
import com.medimg.prediction.application.WorkerResult.Payload;
import com.medimg.prediction.application.WorkerResult.PayloadFinding;
import com.medimg.prediction.domain.Finding;
import com.medimg.prediction.domain.PredictionJob;
import com.medimg.prediction.domain.PredictionJob.FailureOutcome;
import com.medimg.prediction.domain.PredictionResult;
import com.medimg.prediction.infrastructure.FindingRepository;
import com.medimg.prediction.infrastructure.PredictionJobRepository;
import com.medimg.prediction.infrastructure.PredictionResultRepository;
import com.medimg.shared.storage.ObjectStoragePort;

import tools.jackson.databind.ObjectMapper;

/** Applies worker messages ({@code ai.results}) to the job state machine. Idempotent and attempt-aware. */
@Service
public class ResultHandler {

    private static final Logger log = LoggerFactory.getLogger(ResultHandler.class);

    private final PredictionJobRepository jobs;
    private final PredictionResultRepository results;
    private final FindingRepository findings;
    private final JobOutbox outbox;
    private final StudyService studies;
    private final ObjectStoragePort storage;
    private final PredictionProperties props;
    private final ObjectMapper json;
    private final ApplicationEventPublisher events;
    private final Clock clock;

    ResultHandler(PredictionJobRepository jobs, PredictionResultRepository results, FindingRepository findings,
                  JobOutbox outbox, StudyService studies, ObjectStoragePort storage, PredictionProperties props,
                  ObjectMapper json, ApplicationEventPublisher events, Clock clock) {
        this.jobs = jobs;
        this.results = results;
        this.findings = findings;
        this.outbox = outbox;
        this.studies = studies;
        this.storage = storage;
        this.props = props;
        this.json = json;
        this.events = events;
        this.clock = clock;
    }

    @Transactional
    public void handle(WorkerResult r) {
        PredictionJob job = jobs.findById(r.jobId()).orElse(null);
        if (job == null) {
            log.warn("Result for unknown job {} ignored", r.jobId());
            return;
        }
        Instant now = clock.instant();
        if (isRejectedJobMessage(r)) {
            if (!job.getStatus().isTerminal()) {
                fail(job, r.error(), false, now);
                outbox.discardPending(job.getId());
                events.publishEvent(new PredictionChanged(job.getId(), job.getStatus().name(), job.getProgress()));
            }
            return;
        }
        if (!job.accepts(r.attempt())) {
            log.debug("Stale {} for job {} (attempt {}, job attempt {}, status {}) ignored",
                    r.type(), r.jobId(), r.attempt(), job.getAttempt(), job.getStatus());
            return;
        }
        switch (r.type()) {
            case STARTED -> job.markRunning(r.workerId(), now);
            case PROGRESS -> job.updateProgress(r.progress(), now);
            case DONE -> complete(job, r, now);
            case FAILED -> fail(job, r.error(), r.retryable(), now);
        }
        events.publishEvent(new PredictionChanged(job.getId(), job.getStatus().name(), job.getProgress()));
    }

    /** Used by the watchdog for jobs whose worker went silent. */
    @Transactional
    public void timeout(PredictionJob detached, String reason) {
        PredictionJob job = jobs.findById(detached.getId()).orElse(null);
        if (job == null || !job.accepts(detached.getAttempt())) {
            return;
        }
        fail(job, reason, true, clock.instant());
        events.publishEvent(new PredictionChanged(job.getId(), job.getStatus().name(), job.getProgress()));
    }

    private void complete(PredictionJob job, WorkerResult r, Instant now) {
        Payload payload;
        try {
            payload = json.readValue(r.payloadJson(), Payload.class);
        } catch (RuntimeException e) {
            log.error("Job {}: unreadable DONE payload", job.getId(), e);
            fail(job, "Worker returned an unreadable result", false, now);
            return;
        }
        results.findByJobId(job.getId()).ifPresent(old -> { // a manual re-run replaces the previous result
            findings.deleteByResultId(old.getId());
            results.delete(old);
            results.flush();
        });
        Map<String, String> heatmapKeys = new LinkedHashMap<>();
        if (payload.artifacts() != null && payload.artifacts().heatmaps() != null) {
            payload.artifacts().heatmaps().forEach((label, uri) -> heatmapKeys.put(label, storage.keyOf(uri)));
        }
        PredictionResult result = results.save(new PredictionResult(job.getId(), r.payloadJson(),
                json.writeValueAsString(heatmapKeys), payload.inferenceMs()));
        List<PayloadFinding> list = payload.findings() == null ? List.of() : payload.findings();
        findings.saveAll(list.stream()
                .map(f -> new Finding(result.getId(), f.label(), f.confidence(),
                        f.bbox() == null ? null : json.writeValueAsString(f.bbox())))
                .toList());
        job.complete(now);
        log.info("Job {} done: {} findings, {} ms", job.getId(), list.size(), payload.inferenceMs());
    }

    /**
     * A retry is dispatched in this transaction, due after the backoff. Jobs of a deleted case are not retried: their
     * image can no longer be resolved, and nobody can see the result.
     */
    private void fail(PredictionJob job, String error, boolean retryable, Instant now) {
        boolean retry = retryable && studies.exists(job.getStudyId());
        FailureOutcome outcome = job.fail(error == null ? "Unknown worker error" : error, retry, props.maxAttempts(), now);
        if (outcome == FailureOutcome.RETRY_SCHEDULED) {
            Instant due = now.plus(props.backoffBefore(job.getAttempt()));
            outbox.dispatch(job, due);
            log.info("Job {} attempt {} failed ({}), attempt {} at {}", job.getId(), job.getAttempt() - 1, error,
                    job.getAttempt(), due);
        } else {
            log.warn("Job {} failed permanently after attempt {}: {}", job.getId(), job.getAttempt(), error);
        }
    }

    /**
     * The worker could not parse the job message, so it does not know the attempt and reports 0. Re-sending the
     * same message cannot succeed, so the job fails for good whatever its current attempt is.
     */
    private static boolean isRejectedJobMessage(WorkerResult r) {
        return r.type() == WorkerResult.Type.FAILED && r.attempt() == 0 && !r.retryable();
    }
}
