package com.medimg.prediction.infrastructure;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.RedisSystemException;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.PendingMessage;
import org.springframework.data.redis.connection.stream.PendingMessages;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.core.StreamOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.stream.StreamMessageListenerContainer;
import org.springframework.data.redis.stream.StreamMessageListenerContainer.StreamMessageListenerContainerOptions;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.medimg.prediction.application.ResultHandler;
import com.medimg.prediction.application.WorkerResult;

/**
 * Consumes {@code ai.results} with consumer group {@code core}. A message is acknowledged only after it has been
 * applied ({@link ResultHandler} is idempotent, so applying a message twice is harmless).
 * <ul>
 *   <li>A message that could not be applied stays pending and is delivered again once it has been idle for
 *       {@code reclaim-idle}; so are messages left pending by an instance that stopped.</li>
 *   <li>After {@code max-deliveries} deliveries, and at once for malformed messages, the message is copied to
 *       {@code ai.results.dlq} and acknowledged.</li>
 * </ul>
 */
@Component
class ResultStreamConsumer implements SmartLifecycle {

    static final String RESULTS_STREAM = "ai.results";
    static final String DEAD_LETTER_STREAM = "ai.results.dlq";
    static final String CORE_GROUP = "core";

    private static final Logger log = LoggerFactory.getLogger(ResultStreamConsumer.class);
    private static final int PENDING_PAGE_SIZE = 100;

    private final StringRedisTemplate redis;
    private final RedisConnectionFactory connectionFactory;
    private final ResultHandler handler;
    private final ResultStreamProperties props;
    private StreamMessageListenerContainer<String, MapRecord<String, String, String>> container;
    private volatile boolean running;

    ResultStreamConsumer(StringRedisTemplate redis, RedisConnectionFactory connectionFactory, ResultHandler handler,
                         ResultStreamProperties props) {
        this.redis = redis;
        this.connectionFactory = connectionFactory;
        this.handler = handler;
        this.props = props;
    }

    @EventListener(ApplicationReadyEvent.class)
    void startConsuming() {
        ensureGroup();
        var options = StreamMessageListenerContainerOptions.builder()
                .pollTimeout(Duration.ofSeconds(2))
                .batchSize(20)
                .errorHandler(t -> log.error("Error reading {}", RESULTS_STREAM, t))
                .build();
        container = StreamMessageListenerContainer.create(connectionFactory, options);
        container.receive(Consumer.from(CORE_GROUP, props.consumerName()),
                StreamOffset.create(RESULTS_STREAM, ReadOffset.lastConsumed()), this::onMessage);
        container.start();
        running = true;
        log.info("Consuming {} as {}/{}", RESULTS_STREAM, CORE_GROUP, props.consumerName());
    }

    @Scheduled(initialDelayString = "${app.ai.result-stream.reclaim-interval}",
            fixedDelayString = "${app.ai.result-stream.reclaim-interval}")
    void reclaim() {
        if (!running) {
            return;
        }
        try {
            redeliverPending();
        } catch (RuntimeException e) {
            log.error("Could not re-deliver pending {} messages", RESULTS_STREAM, e);
        }
    }

    /** One pass over the pending entries of the group in id order; each entry is looked at once. */
    void redeliverPending() {
        StreamOperations<String, String, String> streams = redis.opsForStream();
        String from = "0-0";
        while (true) {
            PendingMessages page = streams.pending(RESULTS_STREAM, CORE_GROUP, Range.closed(from, "+"), PENDING_PAGE_SIZE);
            for (PendingMessage pending : page) {
                if (pending.getElapsedTimeSinceLastDelivery().compareTo(props.reclaimIdle()) >= 0) {
                    redeliver(streams, pending);
                }
            }
            if (page.size() < PENDING_PAGE_SIZE) {
                return;
            }
            from = successor(page.get(page.size() - 1).getId());
        }
    }

    private void redeliver(StreamOperations<String, String, String> streams, PendingMessage pending) {
        RecordId id = pending.getId();
        if (pending.getTotalDeliveryCount() >= props.maxDeliveries()) {
            List<MapRecord<String, String, String>> records =
                    streams.range(RESULTS_STREAM, Range.closed(id.getValue(), id.getValue()));
            deadLetter(id, records.isEmpty() ? Map.of() : records.getFirst().getValue(),
                    "not applied after " + pending.getTotalDeliveryCount() + " deliveries");
            return;
        }
        // empty if another consumer claimed it in the meantime or the entry no longer exists
        streams.claim(RESULTS_STREAM, CORE_GROUP, props.consumerName(), props.reclaimIdle(), id).forEach(this::onMessage);
    }

    void onMessage(MapRecord<String, String, String> record) {
        try {
            handler.handle(parse(record.getValue()));
        } catch (IllegalArgumentException e) {
            deadLetter(record.getId(), record.getValue(), "malformed: " + e.getMessage());
            return;
        } catch (RuntimeException e) {
            log.error("Failed to apply result message {}; it will be delivered again", record.getId(), e);
            return;
        }
        redis.opsForStream().acknowledge(RESULTS_STREAM, CORE_GROUP, record.getId());
    }

    private void deadLetter(RecordId id, Map<String, String> fields, String reason) {
        Map<String, String> entry = new LinkedHashMap<>(fields);
        entry.put("sourceId", id.getValue());
        entry.put("reason", reason);
        redis.opsForStream().add(DEAD_LETTER_STREAM, entry);
        redis.opsForStream().acknowledge(RESULTS_STREAM, CORE_GROUP, id);
        log.error("Result message {} moved to {}: {}", id, DEAD_LETTER_STREAM, reason);
    }

    static WorkerResult parse(Map<String, String> f) {
        String type = require(f, "type");
        return new WorkerResult(
                UUID.fromString(require(f, "jobId")),
                Integer.parseInt(require(f, "attempt")),
                f.get("workerId"),
                WorkerResult.Type.valueOf(type),
                f.containsKey("progress") ? (int) Double.parseDouble(f.get("progress")) : 0,
                f.get("payload"),
                f.get("error"),
                Boolean.parseBoolean(f.getOrDefault("retryable", "false")));
    }

    private static String require(Map<String, String> f, String key) {
        String v = f.get(key);
        if (v == null || v.isBlank()) {
            throw new IllegalArgumentException("missing field " + key);
        }
        return v;
    }

    /** Smallest stream id greater than {@code id}. */
    private static String successor(RecordId id) {
        return id.getTimestamp() + "-" + (id.getSequence() + 1);
    }

    /** Creates the {@code core} group (and the stream) on first start. The ai-worker owns the job-stream groups. */
    private void ensureGroup() {
        try {
            redis.opsForStream().createGroup(RESULTS_STREAM, ReadOffset.from("0"), CORE_GROUP);
        } catch (RedisSystemException e) {
            String message = e.getMostSpecificCause().getMessage();
            if (message == null || !message.contains("BUSYGROUP")) {
                throw e;
            }
        }
    }

    @Override
    public void start() {
        // started on ApplicationReadyEvent so that the schema and beans are fully ready
    }

    @Override
    public void stop() {
        if (container != null) {
            container.stop();
        }
        running = false;
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}
