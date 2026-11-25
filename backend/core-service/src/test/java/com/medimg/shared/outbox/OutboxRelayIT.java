package com.medimg.shared.outbox;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.shared.messaging.StreamPublisher;
import com.medimg.support.IntegrationTest;

/** The relay itself against PostgreSQL and Redis, with a message type of its own. */
class OutboxRelayIT extends IntegrationTest {

    private static final String TYPE = "TEST_DISPATCH";
    private static final String STREAM = "test.outbox";

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    OutboxRelay relay;

    @Autowired
    OutboxMessageRepository messages;

    @Autowired
    OutboxProperties props;

    @Autowired
    TransactionTemplate tx;

    @Autowired
    Clock clock;

    private final OutboxRoute route = new OutboxRoute() {
        @Override
        public String type() {
            return TYPE;
        }

        @Override
        public String stream() {
            return STREAM;
        }
    };

    @Test
    void concurrentRelaysPublishEachMessageExactlyOnce() throws Exception {
        // due only for the two relays below, whose clock is ahead, so the scheduled relay leaves them alone
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            ids.add(insertPending(clock.instant().plus(Duration.ofMinutes(30))));
        }
        StreamPublisher slowPublisher = (stream, fields) -> {
            try {
                Thread.sleep(30); // keeps each batch locked long enough for the other relay to run into it
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            streams.publish(stream, fields);
        };
        OutboxProperties smallBatches = new OutboxProperties(props.pollInterval(), 3, props.publishBackoff(),
                props.maxPublishBackoff(), props.retention());
        Clock ahead = Clock.offset(clock, Duration.ofHours(1));

        CountDownLatch start = new CountDownLatch(1);
        List<Future<Integer>> results = new ArrayList<>();
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            for (int i = 0; i < 2; i++) {
                OutboxRelay r = new OutboxRelay(messages, List.of(route), slowPublisher, tx, json, smallBatches, ahead);
                results.add(pool.submit(() -> {
                    start.await();
                    int total = 0;
                    for (int n = r.publishDue(); n > 0; n = r.publishDue()) {
                        total += n;
                    }
                    return total;
                }));
            }
            start.countDown();
        }

        int first = results.get(0).get();
        int second = results.get(1).get();
        assertThat(first + second).isEqualTo(20);
        assertThat(first).isPositive();
        assertThat(second).isPositive();
        List<String> published = redis.<String, String>opsForStream().range(STREAM, Range.unbounded()).stream()
                .map(MapRecord::getValue).map(f -> f.get("id")).toList();
        ids.forEach(id -> assertThat(published).as("entries of %s", id).containsOnlyOnce(id));
    }

    @Test
    void publishedMessagesAreDeletedAfterTheRetentionPeriod() {
        String id = UUID.randomUUID().toString();
        insertPublished(id, clock.instant().minus(Duration.ofDays(8)));
        insertPublished(id, clock.instant().minus(Duration.ofDays(1)));

        assertThat(relay.deletePublished()).isPositive();

        List<Map<String, Object>> rows = jdbc.queryForList("select * from outbox_message where aggregate_id = ?::uuid", id);
        assertThat(rows).hasSize(1);
        assertThat(((Timestamp) rows.getFirst().get("published_at")).toInstant()).isAfter(clock.instant().minus(Duration.ofDays(2)));
    }

    private String insertPending(Instant availableAt) {
        String id = UUID.randomUUID().toString();
        jdbc.update("insert into outbox_message (aggregate_id, type, payload, available_at) values (?::uuid, ?, ?::jsonb, ?)",
                id, TYPE, json.writeValueAsString(Map.of("id", id)), Timestamp.from(availableAt));
        return id;
    }

    private void insertPublished(String id, Instant publishedAt) {
        jdbc.update("""
                insert into outbox_message (aggregate_id, type, payload, stream, available_at, published_at)
                values (?::uuid, ?, '{}'::jsonb, ?, ?, ?)
                """, id, TYPE, STREAM, Timestamp.from(publishedAt), Timestamp.from(publishedAt));
    }
}
