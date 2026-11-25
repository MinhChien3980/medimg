package com.medimg.shared.outbox;

import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import tools.jackson.databind.ObjectMapper;

/**
 * Write side of the transactional outbox. A stream entry is stored as an outbox row in the caller's transaction,
 * together with the state change that causes it; {@link OutboxRelay} publishes it once it is due. So a state change is
 * never committed without its message, and a rolled-back one is never published.
 */
@Component
public class Outbox {

    private final OutboxMessageRepository messages;
    private final ObjectMapper json;
    private final Clock clock;

    Outbox(OutboxMessageRepository messages, ObjectMapper json, Clock clock) {
        this.messages = messages;
        this.json = json;
        this.clock = clock;
    }

    /**
     * Schedules {@code fields} for publication at {@code availableAt}, to the stream the {@link OutboxRoute} of
     * {@code type} chooses at that time.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void enqueue(String type, UUID aggregateId, Map<String, String> fields, Instant availableAt) {
        messages.save(new OutboxMessage(type, aggregateId, json.writeValueAsString(fields), availableAt, clock.instant()));
    }

    /** Drops the pending message of the aggregate, if it has not been published yet. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void discardPending(String type, UUID aggregateId) {
        messages.deletePending(type, aggregateId);
    }
}
