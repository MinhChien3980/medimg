package com.medimg.shared.messaging;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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

/**
 * Consumes a stream of worker results with a consumer group. A message is acknowledged only after it has been
 * applied, so {@link #apply(Map)} must be idempotent.
 * <ul>
 *   <li>A message that could not be applied stays pending and is delivered again once it has been idle for
 *       {@code reclaim-idle}; so are messages left pending by an instance that stopped. Subclasses call
 *       {@link #reclaim()} on their own schedule.</li>
 *   <li>After {@code max-deliveries} deliveries, and at once for malformed messages, the message is copied to
 *       {@code <stream>.dlq} and acknowledged.</li>
 * </ul>
 */
public abstract class StreamConsumer implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(StreamConsumer.class);
    private static final int PENDING_PAGE_SIZE = 100;

    private final StringRedisTemplate redis;
    private final RedisConnectionFactory connectionFactory;
    private final String stream;
    private final String group;
    private final String deadLetterStream;
    private final StreamConsumerProperties props;
    private StreamMessageListenerContainer<String, MapRecord<String, String, String>> container;
    private volatile boolean running;

    protected StreamConsumer(StringRedisTemplate redis, RedisConnectionFactory connectionFactory, String stream,
                             String group, StreamConsumerProperties props) {
        this.redis = redis;
        this.connectionFactory = connectionFactory;
        this.stream = stream;
        this.group = group;
        this.deadLetterStream = stream + ".dlq";
        this.props = props;
    }

    /**
     * Applies one message. An {@link IllegalArgumentException} marks the message as malformed: it is dead-lettered
     * at once. Any other exception leaves it pending for another delivery.
     */
    protected abstract void apply(Map<String, String> fields);

    /** Value of a mandatory field; a missing one makes the message malformed. */
    protected static String required(Map<String, String> fields, String key) {
        String value = fields.get(key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("missing field " + key);
        }
        return value;
    }

    /** Started on {@link ApplicationReadyEvent} so that the schema and all beans are ready. */
    @EventListener(ApplicationReadyEvent.class)
    public void startConsuming() {
        ensureGroup();
        var options = StreamMessageListenerContainerOptions.builder()
                .pollTimeout(Duration.ofSeconds(2))
                .batchSize(20)
                .errorHandler(t -> log.error("Error reading {}", stream, t))
                .build();
        container = StreamMessageListenerContainer.create(connectionFactory, options);
        container.receive(Consumer.from(group, props.consumerName()),
                StreamOffset.create(stream, ReadOffset.lastConsumed()), this::onMessage);
        container.start();
        running = true;
        log.info("Consuming {} as {}/{}", stream, group, props.consumerName());
    }

    /** Re-delivers messages that have been pending too long; failures are logged and retried on the next call. */
    public void reclaim() {
        if (!running) {
            return;
        }
        try {
            redeliverPending();
        } catch (RuntimeException e) {
            log.error("Could not re-deliver pending {} messages", stream, e);
        }
    }

    /** One pass over the pending entries of the group in id order; each entry is looked at once. */
    public void redeliverPending() {
        StreamOperations<String, String, String> streams = redis.opsForStream();
        String from = "0-0";
        while (true) {
            PendingMessages page = streams.pending(stream, group, Range.closed(from, "+"), PENDING_PAGE_SIZE);
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
            List<MapRecord<String, String, String>> records = streams.range(stream, Range.closed(id.getValue(), id.getValue()));
            deadLetter(id, records.isEmpty() ? Map.of() : records.getFirst().getValue(),
                    "not applied after " + pending.getTotalDeliveryCount() + " deliveries");
            return;
        }
        // empty if another consumer claimed it in the meantime or the entry no longer exists
        streams.claim(stream, group, props.consumerName(), props.reclaimIdle(), id).forEach(this::onMessage);
    }

    private void onMessage(MapRecord<String, String, String> record) {
        try {
            apply(record.getValue());
        } catch (IllegalArgumentException e) {
            deadLetter(record.getId(), record.getValue(), "malformed: " + e.getMessage());
            return;
        } catch (RuntimeException e) {
            log.error("Failed to apply {} message {}; it will be delivered again", stream, record.getId(), e);
            return;
        }
        redis.opsForStream().acknowledge(stream, group, record.getId());
    }

    private void deadLetter(RecordId id, Map<String, String> fields, String reason) {
        Map<String, String> entry = new LinkedHashMap<>(fields);
        entry.put("sourceId", id.getValue());
        entry.put("reason", reason);
        redis.opsForStream().add(deadLetterStream, entry);
        redis.opsForStream().acknowledge(stream, group, id);
        log.error("{} message {} moved to {}: {}", stream, id, deadLetterStream, reason);
    }

    /** Smallest stream id greater than {@code id}. */
    private static String successor(RecordId id) {
        return id.getTimestamp() + "-" + (id.getSequence() + 1);
    }

    /** Creates the group (and the stream) on first start. Workers own the groups of the job streams. */
    private void ensureGroup() {
        try {
            redis.opsForStream().createGroup(stream, ReadOffset.from("0"), group);
        } catch (RedisSystemException e) {
            String message = e.getMostSpecificCause().getMessage();
            if (message == null || !message.contains("BUSYGROUP")) {
                throw e;
            }
        }
    }

    @Override
    public void start() {
        // consumption starts on ApplicationReadyEvent, see startConsuming()
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
