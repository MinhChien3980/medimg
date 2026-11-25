package com.medimg.prediction.domain;

import java.time.Instant;
import java.util.UUID;

import org.hibernate.annotations.ColumnTransformer;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * AI job aggregate and its state machine.
 * <pre>
 * QUEUED ─(worker STARTED)─► RUNNING ─(DONE)─► DONE
 *    │                          ├─(FAILED retryable, attempt &lt; max)─► QUEUED (attempt+1, dispatched after the backoff)
 *    │                          └─(FAILED otherwise)──────────────────► FAILED
 *    └─(cancel)─► CANCELLED          FAILED/CANCELLED ─(manual retry)─► QUEUED (attempt+1)
 * </pre>
 * Messages from the worker carry the attempt number; messages from an older attempt are ignored. A retry starts the
 * next attempt right away, so results of the failed attempt that arrive during the backoff are ignored as well.
 */
@Entity
@Table(name = "prediction_job")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class PredictionJob {

    public enum FailureOutcome { RETRY_SCHEDULED, FAILED }

    @Id
    private UUID id;

    @Column(name = "study_id", nullable = false)
    private UUID studyId;

    @Column(name = "series_id", nullable = false)
    private UUID seriesId;

    @Column(name = "model_id", nullable = false)
    private UUID modelId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private JobStatus status;

    @Column(nullable = false)
    private short progress;

    @Column(nullable = false)
    private short attempt;

    @Column(columnDefinition = "jsonb")
    @ColumnTransformer(write = "?::jsonb")
    private String params;

    @Column(name = "idempotency_key")
    private String idempotencyKey;

    @Column(name = "worker_id")
    private String workerId;

    @Column(name = "requested_by")
    private UUID requestedBy;

    @Column(name = "queued_at", nullable = false)
    private Instant queuedAt;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "error_message")
    private String errorMessage;

    @Version
    private long version;

    public PredictionJob(UUID studyId, UUID seriesId, UUID modelId, String paramsJson, String idempotencyKey,
                         UUID requestedBy, Instant now) {
        this.id = UUID.randomUUID();
        this.studyId = studyId;
        this.seriesId = seriesId;
        this.modelId = modelId;
        this.params = paramsJson;
        this.idempotencyKey = idempotencyKey;
        this.requestedBy = requestedBy;
        this.status = JobStatus.QUEUED;
        this.attempt = 1;
        this.queuedAt = now;
    }

    /** True if a worker message for {@code messageAttempt} should still be applied. */
    public boolean accepts(int messageAttempt) {
        return !status.isTerminal() && messageAttempt == attempt;
    }

    public void markRunning(String workerId, Instant now) {
        if (status == JobStatus.QUEUED) {
            status = JobStatus.RUNNING;
            startedAt = now;
        }
        this.workerId = workerId;
    }

    public void updateProgress(int value, Instant now) {
        if (status == JobStatus.QUEUED) {
            status = JobStatus.RUNNING;
        }
        if (startedAt == null) {
            startedAt = now;
        }
        progress = (short) Math.max(progress, Math.min(100, Math.max(0, value)));
    }

    public void complete(Instant now) {
        requireNotTerminal();
        status = JobStatus.DONE;
        progress = 100;
        finishedAt = now;
        errorMessage = null;
    }

    public FailureOutcome fail(String error, boolean retryable, int maxAttempts, Instant now) {
        requireNotTerminal();
        errorMessage = error;
        if (retryable && attempt < maxAttempts) {
            startNextAttempt(now);
            return FailureOutcome.RETRY_SCHEDULED;
        }
        status = JobStatus.FAILED;
        finishedAt = now;
        return FailureOutcome.FAILED;
    }

    /** User-initiated retry of a finished (failed / cancelled) job. */
    public void manualRetry(Instant now) {
        if (status != JobStatus.FAILED && status != JobStatus.CANCELLED) {
            throw new IllegalStateException("Only failed or cancelled jobs can be retried");
        }
        startNextAttempt(now);
        finishedAt = null;
        errorMessage = null;
    }

    public void cancel(Instant now) {
        if (status.isTerminal()) {
            throw new IllegalStateException("Job " + id + " is already " + status);
        }
        status = JobStatus.CANCELLED;
        finishedAt = now;
    }

    private void startNextAttempt(Instant now) {
        status = JobStatus.QUEUED;
        attempt++;
        progress = 0;
        queuedAt = now;
        startedAt = null;
        workerId = null;
    }

    private void requireNotTerminal() {
        if (status.isTerminal()) {
            throw new IllegalStateException("Job " + id + " is already " + status);
        }
    }
}
