package com.medimg.prediction.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.doThrow;

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

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.prediction.application.JobQueuePort;
import com.medimg.prediction.application.JobQueuePort.JobMessage;
import com.medimg.support.IntegrationTest;

/** The transactional outbox against PostgreSQL and Redis: what is stored with the job, and what the relay publishes. */
class JobOutboxIT extends IntegrationTest {

    private static final String MODEL_ID = "6f9a3c1e-0b1d-4c55-9a51-7c2f1e0a0001";

    private static String[] study;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    JobOutboxRelay relay;

    @Autowired
    OutboxMessageRepository messages;

    @Autowired
    OutboxProperties props;

    @Autowired
    TransactionTemplate tx;

    @Autowired
    Clock clock;

    private String doctor;

    @BeforeEach
    void setUp() throws Exception {
        doctor = login("doctor");
        if (study == null) {
            study = uploadStudy(doctor, createCase(doctor));
        }
    }

    @Test
    void jobCreatedWhileRedisIsDownIsPublishedOnceRedisIsBack() {
        doThrow(new RedisConnectionFailureException("Redis is down")).when(jobQueue).publish(any(), any());

        String jobId = createJob(Map.of("threshold", 0.4));

        await().atMost(Duration.ofSeconds(10)).until(() -> ((Number) pendingRow(jobId).get("attempts")).intValue() >= 1);
        assertThat((String) pendingRow(jobId).get("last_error")).contains("Redis is down");
        assertThat(jobMessages(jobId)).isEmpty();
        assertThat(get("/predictions/" + jobId, doctor).body().get("status").asString()).isEqualTo("QUEUED");

        doCallRealMethod().when(jobQueue).publish(any(), any());

        Map<String, String> msg = awaitJobMessage(jobId, 1);
        assertThat(msg).containsEntry("jobId", jobId).containsEntry("attempt", "1")
                .containsEntry("modelCode", "cxr-multilabel").containsEntry("modelVersion", "0.1.0-xrv")
                .containsEntry("task", "CLASSIFICATION_2D").containsEntry("inputType", "IMAGE_2D")
                .containsEntry("inputUri", "s3://medimg/studies/" + study[0] + "/series/" + study[1] + "/image.png")
                .containsEntry("outputPrefix", "s3://medimg/predictions/" + jobId + "/1/")
                .containsEntry("params", "{\"threshold\":0.4}")
                .containsKey("enqueuedAt");
        await().atMost(Duration.ofSeconds(5)).until(() -> rows(jobId).getFirst().get("published_at") != null);
        assertThat(rows(jobId).getFirst()).containsEntry("stream", "ai.jobs.cpu");
        assertThat(jobMessages(jobId)).hasSize(1);
    }

    @Test
    void dispatchLeftBehindByACrashedInstanceIsPublished() {
        // committed job and outbox row, as left by an instance that stopped before publishing
        String dueJob = insertJobWithDispatch(clock.instant());
        String laterJob = insertJobWithDispatch(clock.instant().plus(Duration.ofHours(1)));

        assertThat(awaitJobMessage(dueJob, 1)).containsEntry("outputPrefix", "s3://medimg/predictions/" + dueJob + "/1/");

        relay.publishDue();
        assertThat(pendingRow(laterJob).get("attempts")).isEqualTo(0);
        assertThat(jobMessages(laterJob)).isEmpty();
    }

    @Test
    void automaticRetryIsPublishedAsTheNextAttemptOnlyAfterTheBackoff() {
        String jobId = createJob(Map.of());
        awaitJobMessage(jobId, 1);
        workerResult(jobId, 1, "STARTED", Map.of());
        workerResult(jobId, 1, "FAILED", Map.of("error", "CUDA out of memory", "retryable", "true"));

        await().atMost(Duration.ofSeconds(10)).until(() -> get("/predictions/" + jobId, doctor).body().get("attempt").asInt() == 2);
        Map<String, Object> retry = rows(jobId).getLast();
        Instant availableAt = ((Timestamp) retry.get("available_at")).toInstant();
        Instant writtenAt = ((Timestamp) retry.get("created_at")).toInstant();
        assertThat(Duration.between(writtenAt, availableAt)).isBetween(Duration.ofMillis(500), Duration.ofSeconds(1));

        Map<String, String> msg = awaitJobMessage(jobId, 2);
        assertThat(msg).containsEntry("outputPrefix", "s3://medimg/predictions/" + jobId + "/2/");
        assertThat(Instant.parse(msg.get("enqueuedAt"))).isAfterOrEqualTo(availableAt.minusMillis(1));
        assertThat(jobMessages(jobId)).hasSize(2);
    }

    @Test
    void cancellingAJobDropsItsUnpublishedDispatch() {
        doThrow(new RedisConnectionFailureException("Redis is down")).when(jobQueue).publish(any(), any());
        String jobId = createJob(Map.of());
        await().atMost(Duration.ofSeconds(10)).until(() -> ((Number) pendingRow(jobId).get("attempts")).intValue() >= 1);

        assertThat(post("/predictions/" + jobId + "/cancel", doctor, null).body().get("status").asString()).isEqualTo("CANCELLED");

        assertThat(rows(jobId)).isEmpty();
        doCallRealMethod().when(jobQueue).publish(any(), any());
        relay.publishDue();
        await().during(Duration.ofMillis(1500)).atMost(Duration.ofSeconds(3)).until(() -> jobMessages(jobId).isEmpty());
        assertThat(redis.opsForValue().get("ai:job:" + jobId + ":cancelled")).isEqualTo("1");
    }

    @Test
    void concurrentRelaysPublishEachMessageExactlyOnce() throws Exception {
        // due only for the two relays below, whose clock is ahead, so the scheduled relay leaves them alone
        List<String> jobIds = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            jobIds.add(insertJobWithDispatch(clock.instant().plus(Duration.ofMinutes(30))));
        }
        JobQueuePort slowQueue = new JobQueuePort() {
            @Override
            public String chooseQueue() {
                return jobQueue.chooseQueue();
            }

            @Override
            public void publish(String queue, JobMessage message) {
                try {
                    Thread.sleep(30); // keeps each batch locked long enough for the other relay to run into it
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                jobQueue.publish(queue, message);
            }

            @Override
            public void markCancelled(UUID jobId) {
                jobQueue.markCancelled(jobId);
            }
        };
        OutboxProperties smallBatches = new OutboxProperties(props.pollInterval(), 3, props.publishBackoff(),
                props.maxPublishBackoff(), props.retention());
        Clock ahead = Clock.offset(clock, Duration.ofHours(1));

        CountDownLatch start = new CountDownLatch(1);
        List<Future<Integer>> results = new ArrayList<>();
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            for (int i = 0; i < 2; i++) {
                JobOutboxRelay r = new JobOutboxRelay(messages, slowQueue, tx, json, smallBatches, ahead);
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
        jobIds.forEach(jobId -> assertThat(jobMessages(jobId)).as("messages of job %s", jobId).hasSize(1));
    }

    @Test
    void publishedMessagesAreDeletedAfterTheRetentionPeriod() {
        String jobId = insertJob();
        insertPublished(jobId, clock.instant().minus(Duration.ofDays(8)));
        insertPublished(jobId, clock.instant().minus(Duration.ofDays(1)));

        assertThat(relay.deletePublished()).isPositive();

        assertThat(rows(jobId)).hasSize(1);
        assertThat(((Timestamp) rows(jobId).getFirst().get("published_at")).toInstant())
                .isAfter(clock.instant().minus(Duration.ofDays(2)));
    }

    private String createJob(Map<String, Object> params) {
        Response r = post("/predictions", doctor,
                Map.of("studyId", study[0], "seriesId", study[1], "modelCode", "cxr-multilabel", "params", params));
        assertThat(r.status()).isEqualTo(202);
        return r.body().get("jobId").asString();
    }

    private String insertJob() {
        String jobId = UUID.randomUUID().toString();
        jdbc.update("""
                insert into prediction_job (id, study_id, series_id, model_id, status, attempt, params, queued_at)
                values (?::uuid, ?::uuid, ?::uuid, ?::uuid, 'QUEUED', 1, '{}'::jsonb, now())
                """, jobId, study[0], study[1], MODEL_ID);
        return jobId;
    }

    private String insertJobWithDispatch(Instant availableAt) {
        String jobId = insertJob();
        JobMessage message = new JobMessage(UUID.fromString(jobId), 1, "cxr-multilabel", "0.1.0-xrv", "CLASSIFICATION_2D",
                "IMAGE_2D", "s3://medimg/studies/" + study[0] + "/series/" + study[1] + "/image.png",
                "s3://medimg/predictions/" + jobId + "/1/", "{}");
        jdbc.update("insert into outbox_message (job_id, type, payload, available_at) values (?::uuid, ?, ?::jsonb, ?)",
                jobId, OutboxMessage.JOB_DISPATCH, json.writeValueAsString(message), Timestamp.from(availableAt));
        return jobId;
    }

    private void insertPublished(String jobId, Instant publishedAt) {
        jdbc.update("""
                insert into outbox_message (job_id, type, payload, stream, available_at, published_at)
                values (?::uuid, ?, '{}'::jsonb, 'ai.jobs.cpu', ?, ?)
                """, jobId, OutboxMessage.JOB_DISPATCH, Timestamp.from(publishedAt), Timestamp.from(publishedAt));
    }

    private List<Map<String, Object>> rows(String jobId) {
        return jdbc.queryForList("select * from outbox_message where job_id = ?::uuid order by id", jobId);
    }

    private Map<String, Object> pendingRow(String jobId) {
        return jdbc.queryForMap("select * from outbox_message where job_id = ?::uuid and published_at is null", jobId);
    }
}
