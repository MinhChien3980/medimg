package com.medimg.shared.outbox;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
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
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.shared.messaging.StreamPublisher;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

class OutboxRelayTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final OutboxMessageRepository messages = mock(OutboxMessageRepository.class);
    private final OutboxRoute jobs = mock(OutboxRoute.class);
    private final OutboxRoute ingest = mock(OutboxRoute.class);
    private final StreamPublisher publisher = mock(StreamPublisher.class);
    private final ObjectMapper json = JsonMapper.builder().build();
    private final OutboxProperties props = new OutboxProperties(Duration.ofSeconds(1), 2, Duration.ofSeconds(5),
            Duration.ofMinutes(1), Duration.ofDays(7));
    private final OutboxRelay relay;

    OutboxRelayTest() {
        when(jobs.type()).thenReturn("JOB");
        when(ingest.type()).thenReturn("INGEST");
        relay = relay(List.of(jobs, ingest));
    }

    @Test
    void publishesEachTypeToTheStreamItsRouteChoosesWithThePublishTime() {
        OutboxMessage job = message("JOB", 1);
        OutboxMessage upload = message("INGEST", 1);
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(job, upload));
        when(jobs.stream()).thenReturn("ai.jobs.gpu");
        when(ingest.stream()).thenReturn("imaging.jobs");

        assertThat(relay.publishDue()).isEqualTo(2);

        verify(publisher).publish("ai.jobs.gpu", Map.of("id", job.getAggregateId().toString(), "attempt", "1",
                "enqueuedAt", NOW.toString()));
        verify(publisher).publish(eq("imaging.jobs"), argThat(f -> f.get("id").equals(upload.getAggregateId().toString())));
        assertThat(job.getPublishedAt()).isEqualTo(NOW);
        assertThat(job.getStream()).isEqualTo("ai.jobs.gpu");
        assertThat(upload.getStream()).isEqualTo("imaging.jobs");
    }

    @Test
    void routeIsAskedOncePerTypeAndPass() {
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(message("JOB", 1), message("JOB", 2)));
        when(jobs.stream()).thenReturn("ai.jobs.cpu");

        relay.publishDue();

        verify(jobs, times(1)).stream();
        verify(publisher, times(2)).publish(eq("ai.jobs.cpu"), any());
    }

    @Test
    void failedPublishBacksOffOnlyThatMessage() {
        OutboxMessage failing = message("JOB", 1);
        OutboxMessage fine = message("JOB", 1);
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(failing, fine));
        when(jobs.stream()).thenReturn("ai.jobs.cpu");
        doThrow(new RedisConnectionFailureException("connection reset"))
                .when(publisher).publish(eq("ai.jobs.cpu"), argThat(f -> f.get("id").equals(failing.getAggregateId().toString())));

        assertThat(relay.publishDue()).isEqualTo(1);

        assertThat(failing.getPublishedAt()).isNull();
        assertThat(failing.getAttempts()).isEqualTo(1);
        assertThat(failing.getLastError()).contains("connection reset");
        assertThat(failing.getAvailableAt()).isEqualTo(NOW.plusSeconds(5));
        assertThat(fine.getPublishedAt()).isEqualTo(NOW);
    }

    @Test
    void routeThatCannotChooseBacksOffOnlyItsOwnMessages() {
        OutboxMessage job = message("JOB", 1);
        OutboxMessage upload = message("INGEST", 1);
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(job, upload));
        when(jobs.stream()).thenThrow(new RedisConnectionFailureException("Unable to connect"));
        when(ingest.stream()).thenReturn("imaging.jobs");

        assertThat(relay.publishDue()).isEqualTo(1);

        verify(publisher, never()).publish(eq("ai.jobs.cpu"), any());
        assertThat(job.getAttempts()).isEqualTo(1);
        assertThat(job.getAvailableAt()).isEqualTo(NOW.plusSeconds(5));
        assertThat(upload.getPublishedAt()).isEqualTo(NOW);
    }

    @Test
    void messageOfATypeWithoutRouteIsBackedOff() {
        OutboxMessage orphan = message("UNKNOWN", 1);
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(orphan));

        assertThat(relay.publishDue()).isZero();

        verify(publisher, never()).publish(any(), any());
        assertThat(orphan.getLastError()).contains("No outbox route for type UNKNOWN");
    }

    @Test
    void twoRoutesForOneTypeAreRejected() {
        OutboxRoute duplicate = mock(OutboxRoute.class);
        when(duplicate.type()).thenReturn("JOB");

        assertThatThrownBy(() -> relay(List.of(jobs, duplicate)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("JOB");
    }

    @Test
    void relayDrainsFullBatchesAndStopsAtThePartialOne() {
        when(messages.lockDue(NOW, 2)).thenReturn(List.of(message("JOB", 1), message("JOB", 1)))
                .thenReturn(List.of(message("JOB", 1)));
        when(jobs.stream()).thenReturn("ai.jobs.cpu");

        relay.relay();

        verify(messages, times(2)).lockDue(any(), anyInt());
        verify(publisher, times(3)).publish(eq("ai.jobs.cpu"), any());
    }

    @Test
    void relayPassSurvivesADatabaseFailure() {
        when(messages.lockDue(NOW, 2)).thenThrow(new IllegalStateException("connection pool exhausted"));

        relay.relay();

        verify(jobs, never()).stream();
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
        OutboxMessage m = message("JOB", 1);
        m.markFailed("x".repeat(5_000), NOW);
        assertThat(m.getLastError()).hasSize(1_000);
    }

    @Test
    void deletesMessagesPublishedBeforeTheRetentionPeriod() {
        when(messages.deletePublishedBefore(NOW.minus(Duration.ofDays(7)))).thenReturn(3);

        assertThat(relay.deletePublished()).isEqualTo(3);
    }

    private OutboxRelay relay(List<OutboxRoute> routes) {
        return new OutboxRelay(messages, routes, publisher, new TransactionTemplate(mock(PlatformTransactionManager.class)),
                json, props, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private OutboxMessage message(String type, int attempt) {
        UUID id = UUID.randomUUID();
        return new OutboxMessage(type, id, json.writeValueAsString(Map.of("id", id.toString(), "attempt", "" + attempt)),
                NOW, NOW);
    }
}
