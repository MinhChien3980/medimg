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
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.shared.outbox.OutboxRelay;
import com.medimg.support.IntegrationTest;

/** AI job dispatch through the transactional outbox against PostgreSQL and Redis: what is stored, what is published. */
class JobOutboxIT extends IntegrationTest {

    private static final String MODEL_ID = "6f9a3c1e-0b1d-4c55-9a51-7c2f1e0a0001";

    private static String[] study;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    OutboxRelay relay;

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
        doThrow(new RedisConnectionFailureException("Redis is down")).when(streams).publish(any(), any());

        String jobId = createJob(Map.of("threshold", 0.4));

        await().atMost(Duration.ofSeconds(10)).until(() -> ((Number) pendingRow(jobId).get("attempts")).intValue() >= 1);
        assertThat((String) pendingRow(jobId).get("last_error")).contains("Redis is down");
        assertThat(jobMessages(jobId)).isEmpty();
        assertThat(get("/predictions/" + jobId, doctor).body().get("status").asString()).isEqualTo("QUEUED");

        doCallRealMethod().when(streams).publish(any(), any());

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
        doThrow(new RedisConnectionFailureException("Redis is down")).when(streams).publish(any(), any());
        String jobId = createJob(Map.of());
        await().atMost(Duration.ofSeconds(10)).until(() -> ((Number) pendingRow(jobId).get("attempts")).intValue() >= 1);

        assertThat(post("/predictions/" + jobId + "/cancel", doctor, null).body().get("status").asString()).isEqualTo("CANCELLED");

        assertThat(rows(jobId)).isEmpty();
        doCallRealMethod().when(streams).publish(any(), any());
        relay.publishDue();
        await().during(Duration.ofMillis(1500)).atMost(Duration.ofSeconds(3)).until(() -> jobMessages(jobId).isEmpty());
        assertThat(redis.opsForValue().get("ai:job:" + jobId + ":cancelled")).isEqualTo("1");
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
        Map<String, String> message = Map.of("jobId", jobId, "attempt", "1", "modelCode", "cxr-multilabel",
                "modelVersion", "0.1.0-xrv", "task", "CLASSIFICATION_2D", "inputType", "IMAGE_2D",
                "inputUri", "s3://medimg/studies/" + study[0] + "/series/" + study[1] + "/image.png",
                "outputPrefix", "s3://medimg/predictions/" + jobId + "/1/", "params", "{}");
        jdbc.update("insert into outbox_message (aggregate_id, type, payload, available_at) values (?::uuid, ?, ?::jsonb, ?)",
                jobId, "JOB_DISPATCH", json.writeValueAsString(message), Timestamp.from(availableAt));
        return jobId;
    }

    private List<Map<String, Object>> rows(String jobId) {
        return jdbc.queryForList("select * from outbox_message where aggregate_id = ?::uuid order by id", jobId);
    }

    private Map<String, Object> pendingRow(String jobId) {
        return jdbc.queryForMap("select * from outbox_message where aggregate_id = ?::uuid and published_at is null", jobId);
    }
}
