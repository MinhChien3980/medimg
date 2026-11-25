package com.medimg.prediction.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.prediction.application.JobQueuePort;
import com.medimg.prediction.application.JobQueuePort.JobMessage;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

class JobOutboxRelayTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final OutboxMessageRepository messages = mock(OutboxMessageRepository.class);
    private final JobQueuePort queue = mock(JobQueuePort.class);
    private final ObjectMapper json = JsonMapper.builder().build();
    private final OutboxProperties props = new OutboxProperties(Duration.ofSeconds(1), 2, Duration.ofSeconds(5),
            Duration.ofMinutes(1), Duration.ofDays(7));
    private final JobOutboxRelay relay = new JobOutboxRelay(messages, queue,
            new TransactionTemplate(mock(PlatformTransactionManager.class)), json, props, Clock.fixed(NOW, ZoneOffset.UTC));

    @Test
    void publishesDueMessagesToTheChosenStream() {
        OutboxMessage first = message(1);
        OutboxMessage second = message(2);
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(first, second));
        when(queue.chooseQueue()).thenReturn("ai.jobs.gpu");

        assertThat(relay.publishDue()).isEqualTo(2);

        verify(queue).publish(eq("ai.jobs.gpu"), argThat(m -> m.jobId().equals(first.getJobId()) && m.attempt() == 1));
        verify(queue).publish(eq("ai.jobs.gpu"), argThat(m -> m.jobId().equals(second.getJobId()) && m.attempt() == 2));
        assertThat(first.getPublishedAt()).isEqualTo(NOW);
        assertThat(first.getStream()).isEqualTo("ai.jobs.gpu");
    }

    @Test
    void failedPublishBacksOffOnlyThatMessage() {
        OutboxMessage failing = message(1);
        OutboxMessage fine = message(1);
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(failing, fine));
        when(queue.chooseQueue()).thenReturn("ai.jobs.cpu");
        doThrow(new RedisConnectionFailureException("connection reset"))
                .when(queue).publish(eq("ai.jobs.cpu"), argThat(m -> m.jobId().equals(failing.getJobId())));

        assertThat(relay.publishDue()).isEqualTo(1);

        assertThat(failing.getPublishedAt()).isNull();
        assertThat(failing.getAttempts()).isEqualTo(1);
        assertThat(failing.getLastError()).contains("connection reset");
        assertThat(failing.getAvailableAt()).isEqualTo(NOW.plusSeconds(5));
        assertThat(fine.getPublishedAt()).isEqualTo(NOW);
    }

    @Test
    void unreachableRedisBacksOffTheWholeBatch() {
        OutboxMessage m = message(1);
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(m));
        when(queue.chooseQueue()).thenThrow(new RedisConnectionFailureException("Unable to connect"));

        assertThat(relay.publishDue()).isZero();

        verify(queue, never()).publish(any(), any());
        assertThat(m.getAttempts()).isEqualTo(1);
        assertThat(m.getAvailableAt()).isEqualTo(NOW.plusSeconds(5));
    }

    @Test
    void relayDrainsFullBatchesAndStopsAtThePartialOne() {
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(message(1), message(1))).thenReturn(List.of(message(1)));
        when(queue.chooseQueue()).thenReturn("ai.jobs.cpu");

        relay.relay();

        verify(messages, times(2)).lockDue(any(), anyInt());
        verify(queue, times(3)).publish(eq("ai.jobs.cpu"), any());
    }

    @Test
    void relayPassSurvivesADatabaseFailure() {
        when(messages.lockDue(NOW, 2)).thenThrow(new IllegalStateException("connection pool exhausted"));

        relay.relay();

        verify(queue, never()).chooseQueue();
    }

    @Test
    void publishBackoffDoublesUpToTheMaximum() {
        assertThat(props.backoffAfter(1)).isEqualTo(Duration.ofSeconds(5));
        assertThat(props.backoffAfter(2)).isEqualTo(Duration.ofSeconds(10));
        assertThat(props.backoffAfter(4)).isEqualTo(Duration.ofSeconds(40));
        assertThat(props.backoffAfter(5)).isEqualTo(Duration.ofMinutes(1));
        assertThat(props.backoffAfter(1_000)).isEqualTo(Duration.ofMinutes(1));
    }

    @Test
    void longErrorsAreTruncated() {
        OutboxMessage m = message(1);
        m.markFailed("x".repeat(5_000), NOW);
        assertThat(m.getLastError()).hasSize(1_000);
    }

    @Test
    void deletesMessagesPublishedBeforeTheRetentionPeriod() {
        when(messages.deletePublishedBefore(NOW.minus(Duration.ofDays(7)))).thenReturn(3);

        assertThat(relay.deletePublished()).isEqualTo(3);
    }

    private OutboxMessage message(int attempt) {
        UUID jobId = UUID.randomUUID();
        JobMessage payload = new JobMessage(jobId, attempt, "cxr", "1", "CLASSIFICATION_2D", "IMAGE_2D", "s3://b/in.png",
                "s3://b/predictions/" + jobId + "/" + attempt + "/", "{}");
        return OutboxMessage.jobDispatch(jobId, json.writeValueAsString(payload), NOW, NOW);
    }
}
