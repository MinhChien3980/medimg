package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.imaging.application.StaleUploadSweeper;
import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/** Upload → study → AI job → (simulated worker on Redis Streams) → findings, including retry and stale messages. */
class UploadAndPredictionIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    StaleUploadSweeper sweeper;

    @Test
    void uploadThenPredictWithRetryAndStaleMessage() throws Exception {
        String doctor = login("doctor");
        String patientId = post("/patients", doctor, Map.of("note", "it-upload")).body().get("id").asString();

        // 1. upload via presigned PUT
        byte[] png = png(600, 500);
        Response init = post("/uploads/init", doctor, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", "../../evil name.png", "size", png.length, "contentType", "image/png"))));
        assertThat(init.status()).isEqualTo(201);
        String uploadId = init.body().get("uploadId").asString();
        String putUrl = init.body().get("files").get(0).get("putUrl").asString();
        assertThat(putUrl).contains("/uploads/" + uploadId + "/").doesNotContain("..");

        assertThat(post("/uploads/" + uploadId + "/complete", doctor, null).status()).isEqualTo(409); // not uploaded yet
        assertThat(putObject(putUrl, png).statusCode()).isEqualTo(200);
        assertThat(post("/uploads/" + uploadId + "/complete", doctor, null).status()).isEqualTo(202);

        await().atMost(Duration.ofSeconds(20)).until(() -> "DONE".equals(get("/uploads/" + uploadId, doctor).body().get("status").asString()));
        String studyId = get("/uploads/" + uploadId, doctor).body().get("studyId").asString();
        JsonNode study = get("/studies/" + studyId, doctor).body();
        JsonNode series = study.get("series").get(0);
        assertThat(series.get("cols").asInt()).isEqualTo(600);
        assertThat(series.get("rows").asInt()).isEqualTo(500);
        var image = raw.send(HttpRequest.newBuilder(URI.create(series.get("imageUrl").asString())).build(),
                HttpResponse.BodyHandlers.ofByteArray());
        assertThat(image.statusCode()).isEqualTo(200);
        assertThat(get("/patients/" + patientId + "/studies", doctor).body().size()).isEqualTo(1);

        // 2. create the job (idempotent)
        String seriesId = series.get("id").asString();
        Map<String, Object> req = Map.of("studyId", studyId, "seriesId", seriesId, "modelCode", "cxr-multilabel",
                "params", Map.of("threshold", 0.4));
        Response job = call("POST", "/predictions", doctor, req, Map.of("Idempotency-Key", "it-key-1"));
        assertThat(job.status()).isEqualTo(202);
        String jobId = job.body().get("jobId").asString();
        assertThat(call("POST", "/predictions", doctor, req, Map.of("Idempotency-Key", "it-key-1")).body()
                .get("jobId").asString()).isEqualTo(jobId);

        Map<String, String> msg = awaitJobMessage(jobId, 1);
        assertThat(msg).containsEntry("jobId", jobId).containsEntry("attempt", "1")
                .containsEntry("modelCode", "cxr-multilabel").containsEntry("inputType", "IMAGE_2D")
                .containsEntry("params", "{\"threshold\":0.4}");
        assertThat(msg.get("inputUri")).isEqualTo("s3://medimg/studies/" + studyId + "/series/" + seriesId + "/image.png");
        assertThat(msg.get("outputPrefix")).isEqualTo("s3://medimg/predictions/" + jobId + "/1/");

        // 3. worker: started, progress, retryable failure → re-queued as attempt 2 after the backoff
        workerResult(jobId, 1, "STARTED", Map.of());
        workerResult(jobId, 1, "PROGRESS", Map.of("progress", "40"));
        await().atMost(Duration.ofSeconds(10)).until(() -> get("/predictions/" + jobId, doctor).body().get("progress").asInt() == 40);
        workerResult(jobId, 1, "FAILED", Map.of("error", "S3 timeout", "retryable", "true"));
        await().atMost(Duration.ofSeconds(10)).until(() -> get("/predictions/" + jobId, doctor).body().get("attempt").asInt() == 2);
        assertThat(awaitJobMessage(jobId, 2).get("outputPrefix")).isEqualTo("s3://medimg/predictions/" + jobId + "/2/");
        assertThat(jobMessages(jobId)).hasSize(2);

        // 4. a late DONE from attempt 1 is ignored; DONE from attempt 2 is applied
        workerResult(jobId, 1, "DONE", Map.of("payload", "{\"findings\":[{\"label\":\"Stale\",\"confidence\":0.9}]}"));
        String payload = """
                {"modelVersion":"0.1.0-xrv","inferenceMs":987,
                 "findings":[{"label":"Effusion","confidence":0.31,"bbox":null},
                             {"label":"Cardiomegaly","confidence":0.87123,"bbox":[1,2,3,4]}],
                 "artifacts":{"heatmaps":{"Cardiomegaly":"s3://medimg/predictions/%s/2/heatmap-Cardiomegaly.png"}}}
                """.formatted(jobId);
        workerResult(jobId, 2, "DONE", Map.of("payload", payload));
        await().atMost(Duration.ofSeconds(10)).until(() -> "DONE".equals(get("/predictions/" + jobId, doctor).body().get("status").asString()));

        JsonNode done = get("/predictions/" + jobId, doctor).body();
        assertThat(done.get("inferenceMs").asInt()).isEqualTo(987);
        assertThat(done.get("params").get("threshold").asDouble()).isEqualTo(0.4);
        assertThat(done.get("findings").size()).isEqualTo(2);
        assertThat(done.get("findings").get(0).get("label").asString()).isEqualTo("Cardiomegaly"); // sorted by confidence
        assertThat(done.get("findings").get(0).get("confidence").decimalValue()).isEqualByComparingTo("0.8712");
        assertThat(done.get("findings").get(0).get("bbox").size()).isEqualTo(4);
        assertThat(done.get("artifacts").get("heatmaps").get("Cardiomegaly").asString()).contains("heatmap-Cardiomegaly.png");
        assertThat(get("/studies/" + studyId + "/predictions", doctor).body().size()).isEqualTo(1);

        // 5. finished jobs cannot be cancelled; the audit trail exists
        assertThat(post("/predictions/" + jobId + "/cancel", doctor, null).status()).isEqualTo(409);
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'PREDICTION_CREATE' and resource_id = ?", Long.class, jobId) >= 1);
    }

    @Test
    void rejectsInvalidUploadsAndHidesThemFromOtherUsers() throws Exception {
        String tech = login("tech");
        String patientId = createCase(tech);

        Response wrongType = post("/uploads/init", tech, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", "a.bmp", "size", 10, "contentType", "image/bmp"))));
        assertThat(wrongType.status()).isEqualTo(400);

        Response twoFiles = post("/uploads/init", tech, Map.of("patientId", patientId, "files", List.of(
                Map.of("name", "a.png", "size", 10, "contentType", "image/png"),
                Map.of("name", "b.png", "size", 10, "contentType", "image/png"))));
        assertThat(twoFiles.status()).isEqualTo(400);
        assertThat(twoFiles.body().get("errors").get(0).get("field").asString()).isEqualTo("files");
        assertThat(post("/uploads/init", tech, Map.of("patientId", patientId, "files", List.of())).status()).isEqualTo(400);

        // a "PNG" that is really text → FAILED with a clear reason
        byte[] fake = "definitely not an image".getBytes(StandardCharsets.UTF_8);
        Response init = post("/uploads/init", tech, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", "x.png", "size", fake.length, "contentType", "image/png"))));
        String uploadId = init.body().get("uploadId").asString();
        putObject(init.body().get("files").get(0).get("putUrl").asString(), fake);
        post("/uploads/" + uploadId + "/complete", tech, null);
        await().atMost(Duration.ofSeconds(20)).until(() -> "FAILED".equals(get("/uploads/" + uploadId, tech).body().get("status").asString()));
        assertThat(get("/uploads/" + uploadId, tech).body().get("error").asString()).contains("not a PNG or JPEG");

        // another user cannot see this upload
        assertThat(get("/uploads/" + uploadId, login("doctor")).status()).isEqualTo(404);
    }

    @Test
    void cancelQueuedJob() throws Exception {
        String doctor = login("doctor");
        String[] ids = uploadStudy(doctor, createCase(doctor));
        String jobId = post("/predictions", doctor, Map.of("studyId", ids[0], "seriesId", ids[1], "modelCode", "cxr-multilabel"))
                .body().get("jobId").asString();
        assertThat(get("/predictions/" + jobId, doctor).body().get("params").isObject()).isTrue();
        assertThat(get("/predictions/" + jobId, doctor).body().get("params").size()).isZero();

        Response cancelled = post("/predictions/" + jobId + "/cancel", doctor, null);
        assertThat(cancelled.body().get("status").asString()).isEqualTo("CANCELLED");
        await().atMost(Duration.ofSeconds(5)).until(() -> "1".equals(redis.opsForValue().get("ai:job:" + jobId + ":cancelled")));

        Response retried = post("/predictions/" + jobId + "/retry", doctor, null);
        assertThat(retried.body().get("status").asString()).isEqualTo("QUEUED");
        assertThat(retried.body().get("attempt").asInt()).isEqualTo(2);
        assertThat(post("/predictions", doctor, Map.of("studyId", ids[0], "seriesId", ids[1], "modelCode", "nope")).status())
                .isEqualTo(400);
    }

    @Test
    void jobTheWorkerCannotParseFailsPermanently() throws Exception {
        String doctor = login("doctor");
        String[] ids = uploadStudy(doctor, createCase(doctor));
        String jobId = post("/predictions", doctor, Map.of("studyId", ids[0], "seriesId", ids[1], "modelCode", "cxr-multilabel"))
                .body().get("jobId").asString();

        // the worker reports attempt 0 when it cannot read the attempt of the job message
        workerResult(jobId, 0, "FAILED", Map.of("error", "attempt is not an integer: 'x'", "retryable", "false"));

        await().atMost(Duration.ofSeconds(10)).until(() -> "FAILED".equals(get("/predictions/" + jobId, doctor).body().get("status").asString()));
        JsonNode failed = get("/predictions/" + jobId, doctor).body();
        assertThat(failed.get("attempt").asInt()).isEqualTo(1);
        assertThat(failed.get("error").asString()).contains("attempt is not an integer");
    }

    @Test
    void studiesAndPredictionsOfADeletedCaseAreNotFound() throws Exception {
        String doctor = login("doctor");
        String patientId = createCase(doctor);
        String[] ids = uploadStudy(doctor, patientId);
        String jobId = post("/predictions", doctor, Map.of("studyId", ids[0], "seriesId", ids[1], "modelCode", "cxr-multilabel"))
                .body().get("jobId").asString();
        assertThat(get("/studies/" + ids[0], doctor).status()).isEqualTo(200);

        assertThat(call("DELETE", "/patients/" + patientId, login("admin"), null, Map.of()).status()).isEqualTo(204);

        assertThat(get("/patients/" + patientId + "/studies", doctor).status()).isEqualTo(404);
        assertThat(get("/studies/" + ids[0], doctor).status()).isEqualTo(404);
        assertThat(get("/studies/" + ids[0] + "/predictions", doctor).status()).isEqualTo(404);
        assertThat(get("/predictions/" + jobId, doctor).status()).isEqualTo(404);
        assertThat(get("/predictions/" + jobId + "/events", doctor).status()).isEqualTo(404);
        assertThat(post("/predictions/" + jobId + "/cancel", doctor, null).status()).isEqualTo(404);
        assertThat(post("/predictions", doctor, Map.of("studyId", ids[0], "seriesId", ids[1], "modelCode", "cxr-multilabel"))
                .status()).isEqualTo(404);
    }

    @Test
    void uploadsStuckInProcessingAreMarkedFailed() {
        String tech = login("tech");
        String patientId = createCase(tech);
        String stuck = initUpload(tech, patientId);
        String recent = initUpload(tech, patientId);
        // as left behind by an instance that stopped while processing
        jdbc.update("update upload_session set status = 'PROCESSING', updated_at = now() - interval '11 minutes' where id = ?::uuid", stuck);
        jdbc.update("update upload_session set status = 'PROCESSING', updated_at = now() - interval '1 minute' where id = ?::uuid", recent);

        assertThat(sweeper.failStaleUploads()).isPositive();

        JsonNode failed = get("/uploads/" + stuck, tech).body();
        assertThat(failed.get("status").asString()).isEqualTo("FAILED");
        assertThat(failed.get("error").asString()).contains("upload the image again");
        assertThat(get("/uploads/" + recent, tech).body().get("status").asString()).isEqualTo("PROCESSING");
    }

    private String initUpload(String token, String patientId) {
        return post("/uploads/init", token, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", "s.png", "size", 10, "contentType", "image/png"))))
                .body().get("uploadId").asString();
    }
}
