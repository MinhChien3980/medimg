package com.medimg.prediction.application;

import java.util.UUID;

/**
 * Signals to AI workers outside the job streams. Job messages themselves go through the outbox
 * ({@link JobOutbox}) to {@code ai.jobs.gpu} / {@code ai.jobs.cpu}.
 */
public interface JobQueuePort {

    /** Tells workers to skip the job if they receive it. */
    void markCancelled(UUID jobId);
}
