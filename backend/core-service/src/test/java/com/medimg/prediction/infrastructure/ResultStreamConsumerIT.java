package com.medimg.prediction.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.medimg.prediction.application.ResultHandler;

/** The result consumer against a real Redis, with the application side ({@link ResultHandler}) mocked. */
@Testcontainers
class ResultStreamConsumerIT {

    @Container
    @SuppressWarnings("resource")
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    private static final int MAX_DELIVERIES = 5;

    private LettuceConnectionFactory connectionFactory;
    private StringRedisTemplate redis;
    private final ResultHandler handler = mock(ResultHandler.class);
    private ResultStreamConsumer consumer;

    @BeforeEach
    void setUp() {
        connectionFactory = new LettuceConnectionFactory(new RedisStandaloneConfiguration(REDIS.getHost(), REDIS.getMappedPort(6379)));
        connectionFactory.afterPropertiesSet();
        connectionFactory.start();
        redis = new StringRedisTemplate(connectionFactory);
        redis.getRequiredConnectionFactory().getConnection().serverCommands().flushAll();
        consumer = new ResultStreamConsumer(redis, connectionFactory, handler,
                new ResultStreamProperties("core-test", MAX_DELIVERIES, Duration.ZERO, Duration.ofSeconds(1)));
    }

    @AfterEach
    void tearDown() {
        consumer.stop();
        connectionFactory.destroy();
    }

    @Test
    void poisonMessageDoesNotBlockStartupAndEndsInTheDeadLetterStream() {
        doThrow(new IllegalStateException("cannot apply")).when(handler).handle(any());
        String id = addResult(UUID.randomUUID().toString());

        assertTimeoutPreemptively(Duration.ofSeconds(10), consumer::startConsuming);
        verify(handler, timeout(5_000)).handle(any()); // first delivery, by the stream listener

        for (int pass = 0; pass < MAX_DELIVERIES; pass++) {
            assertTimeoutPreemptively(Duration.ofSeconds(5), consumer::redeliverPending);
        }

        verify(handler, times(MAX_DELIVERIES)).handle(any());
        List<MapRecord<String, Object, Object>> dead = redis.opsForStream().range("ai.results.dlq", Range.unbounded());
        assertThat(dead).hasSize(1);
        assertThat(dead.getFirst().getValue()).containsEntry("sourceId", id).containsEntry("type", "FAILED")
                .containsKey("reason");
        assertThat(pendingCount()).isZero();
    }

    @Test
    void transientFailureIsRetriedWithoutRestart() {
        doThrow(new IllegalStateException("database briefly unavailable")).doNothing().when(handler).handle(any());
        addResult(UUID.randomUUID().toString());

        consumer.startConsuming();
        verify(handler, timeout(5_000)).handle(any());
        consumer.redeliverPending();

        verify(handler, times(2)).handle(any());
        assertThat(pendingCount()).isZero();
        assertThat(redis.hasKey("ai.results.dlq")).isFalse();
    }

    @Test
    void malformedMessageIsDeadLetteredAtOnce() {
        doNothing().when(handler).handle(any());
        String id = addResult("not-a-uuid");

        consumer.startConsuming();

        await().atMost(Duration.ofSeconds(5)).until(() -> redis.hasKey("ai.results.dlq"));
        verify(handler, never()).handle(any());
        assertThat(redis.opsForStream().range("ai.results.dlq", Range.unbounded()).getFirst().getValue())
                .containsEntry("sourceId", id);
        assertThat(pendingCount()).isZero();
    }

    private String addResult(String jobId) {
        return redis.opsForStream().add("ai.results", Map.of("jobId", jobId, "attempt", "1", "workerId", "w",
                "type", "FAILED", "error", "boom", "retryable", "false")).getValue();
    }

    private long pendingCount() {
        return redis.opsForStream().pending("ai.results", "core").getTotalPendingMessages();
    }
}
