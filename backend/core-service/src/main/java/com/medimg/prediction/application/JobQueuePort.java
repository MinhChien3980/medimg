package com.medimg.prediction.application;

import java.util.UUID;

/** Hand-off of AI jobs to workers, implemented with Redis Streams ({@code ai.jobs.gpu} / {@code ai.jobs.cpu}). */
public interface JobQueuePort {

    record JobMessage(UUID jobId, int attempt, String modelCode, String modelVersion, String task, String inputType,
                      String inputUri, String outputPrefix, String paramsJson) {
    }

    /** GPU queue when a GPU worker is alive (heartbeat), otherwise the CPU queue. */
    String chooseQueue();

    /** Appends the message to the stream. Only the outbox relay publishes, never the code that changes a job. */
    void publish(String queue, JobMessage message);

    /** Tells workers to skip the job if they receive it. */
    void markCancelled(UUID jobId);
}
