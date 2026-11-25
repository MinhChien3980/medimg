package com.medimg.prediction.infrastructure;

import java.time.Instant;
import java.util.UUID;

import org.hibernate.annotations.ColumnTransformer;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/** A job dispatch stored with the job state change and published to Redis by {@link JobOutboxRelay}. */
@Entity
@Table(name = "outbox_message")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class OutboxMessage {

    /** The only message type: one attempt of an AI job, published to {@code ai.jobs.gpu} or {@code ai.jobs.cpu}. */
    public static final String JOB_DISPATCH = "JOB_DISPATCH";

    private static final int MAX_ERROR_LENGTH = 1000;

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "job_id", nullable = false)
    private UUID jobId;

    @Column(nullable = false)
    private String type;

    @Column(columnDefinition = "jsonb", nullable = false)
    @ColumnTransformer(write = "?::jsonb")
    private String payload;

    private String stream;

    @Column(name = "available_at", nullable = false)
    private Instant availableAt;

    @Column(name = "published_at")
    private Instant publishedAt;

    @Column(nullable = false)
    private int attempts;

    @Column(name = "last_error")
    private String lastError;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    public static OutboxMessage jobDispatch(UUID jobId, String payloadJson, Instant availableAt, Instant now) {
        OutboxMessage m = new OutboxMessage();
        m.jobId = jobId;
        m.type = JOB_DISPATCH;
        m.payload = payloadJson;
        m.availableAt = availableAt;
        m.createdAt = now;
        return m;
    }

    void markPublished(String streamName, Instant now) {
        stream = streamName;
        publishedAt = now;
    }

    void markFailed(String error, Instant retryAt) {
        attempts++;
        lastError = error == null || error.length() <= MAX_ERROR_LENGTH ? error : error.substring(0, MAX_ERROR_LENGTH);
        availableAt = retryAt;
    }
}
