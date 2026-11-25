package com.medimg.shared.outbox;

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

/** A stream entry stored with the state change that caused it and published to Redis by {@link OutboxRelay}. */
@Entity
@Table(name = "outbox_message")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
class OutboxMessage {

    private static final int MAX_ERROR_LENGTH = 1000;

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** The job, upload, ... the message belongs to; at most one message per type and aggregate is pending. */
    @Column(name = "aggregate_id", nullable = false)
    private UUID aggregateId;

    @Column(nullable = false)
    private String type;

    /** JSON object: the fields of the stream entry. */
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

    OutboxMessage(String type, UUID aggregateId, String payloadJson, Instant availableAt, Instant now) {
        this.type = type;
        this.aggregateId = aggregateId;
        this.payload = payloadJson;
        this.availableAt = availableAt;
        this.createdAt = now;
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
