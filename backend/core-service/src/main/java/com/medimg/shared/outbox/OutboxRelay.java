package com.medimg.shared.outbox;

import java.time.Clock;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.shared.messaging.StreamPublisher;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * Publishes due outbox messages to Redis streams. Each pass claims due rows with {@code FOR UPDATE SKIP LOCKED}, so
 * several core-service instances can relay side by side. The stream of a message is chosen by the {@link OutboxRoute}
 * of its type, once per type and pass; a message whose route or publish fails is backed off on its own and does not
 * hold up the others. Every entry gets an {@code enqueuedAt} field with the publish time.
 * <p>
 * Delivery is at-least-once: if the commit fails after the XADD, the message is published again. Consumers handle that
 * because they apply a result only once and only for the current attempt.
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);
    private static final TypeReference<LinkedHashMap<String, String>> FIELDS = new TypeReference<>() { };

    /** The stream a route chose for this pass, or why it could not choose one. */
    private record Resolution(String stream, RuntimeException failure) {
    }

    private final OutboxMessageRepository messages;
    private final Map<String, OutboxRoute> routes;
    private final StreamPublisher publisher;
    private final TransactionTemplate tx;
    private final ObjectMapper json;
    private final OutboxProperties props;
    private final Clock clock;

    OutboxRelay(OutboxMessageRepository messages, List<OutboxRoute> routes, StreamPublisher publisher,
                TransactionTemplate tx, ObjectMapper json, OutboxProperties props, Clock clock) {
        this.messages = messages;
        this.routes = routes.stream().collect(Collectors.toMap(OutboxRoute::type, Function.identity(), (a, b) -> {
            throw new IllegalStateException("Two outbox routes for type " + a.type());
        }));
        this.publisher = publisher;
        this.tx = tx;
        this.json = json;
        this.props = props;
        this.clock = clock;
    }

    /** Drains due messages batch by batch; stops at the first batch that was not full or not fully published. */
    @Scheduled(initialDelayString = "${app.outbox.poll-interval}", fixedDelayString = "${app.outbox.poll-interval}")
    void relay() {
        try {
            while (publishDue() == props.batchSize()) {
                log.debug("Outbox batch full, relaying the next one");
            }
        } catch (RuntimeException e) {
            log.error("Outbox relay pass failed", e);
        }
    }

    /** Publishes one batch of due messages in one transaction; returns how many were published. */
    public int publishDue() {
        Integer published = tx.execute(s -> {
            List<OutboxMessage> due = messages.lockDue(clock.instant(), props.batchSize());
            Map<String, Resolution> streams = new HashMap<>();
            int count = 0;
            for (OutboxMessage m : due) {
                Resolution route = streams.computeIfAbsent(m.getType(), this::resolve);
                if (route.failure() != null) {
                    backOff(m, route.failure());
                    continue;
                }
                try {
                    Map<String, String> fields = json.readValue(m.getPayload(), FIELDS);
                    fields.put("enqueuedAt", clock.instant().toString());
                    publisher.publish(route.stream(), fields);
                    m.markPublished(route.stream(), clock.instant());
                    log.info("{} of {} → {}", m.getType(), m.getAggregateId(), route.stream());
                    count++;
                } catch (RuntimeException e) {
                    backOff(m, e);
                }
            }
            return count;
        });
        return published == null ? 0 : published;
    }

    /** Deletes published messages older than the retention period; returns how many were deleted. */
    @Scheduled(initialDelay = 1, fixedDelay = 1, timeUnit = TimeUnit.HOURS)
    int deletePublished() {
        Instant before = clock.instant().minus(props.retention());
        Integer deleted = tx.execute(s -> messages.deletePublishedBefore(before));
        if (deleted != null && deleted > 0) {
            log.info("Deleted {} outbox messages published before {}", deleted, before);
        }
        return deleted == null ? 0 : deleted;
    }

    private Resolution resolve(String type) {
        OutboxRoute route = routes.get(type);
        if (route == null) {
            return new Resolution(null, new IllegalStateException("No outbox route for type " + type));
        }
        try {
            return new Resolution(route.stream(), null);
        } catch (RuntimeException e) {
            return new Resolution(null, e);
        }
    }

    private void backOff(OutboxMessage m, RuntimeException e) {
        Instant retryAt = clock.instant().plus(props.backoffAfter(m.getAttempts() + 1));
        m.markFailed(e.toString(), retryAt);
        log.warn("Could not publish outbox message {} ({} of {}, failure {}), next try at {}: {}",
                m.getId(), m.getType(), m.getAggregateId(), m.getAttempts(), retryAt, e.toString());
    }
}
