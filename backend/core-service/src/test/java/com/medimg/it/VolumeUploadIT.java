package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.imaging.application.StaleUploadSweeper;
import com.medimg.shared.storage.ObjectNotFoundException;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.support.IntegrationTest;
import com.medimg.support.TestFiles;

import tools.jackson.databind.JsonNode;

/** Volume upload → outbox → {@code imaging.jobs} → (simulated ingest worker on {@code imaging.results}) → study. */
class VolumeUploadIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    ObjectStoragePort storage;

    @Autowired
    StaleUploadSweeper sweeper;

    @Test
    void niftiUploadIsIngestedIntoAVolumeStudy() throws Exception {
        String tech = login("tech");
        String patientId = createCase(tech);
        byte[] volume = TestFiles.gzip(TestFiles.nifti1());

        JsonNode completed = startVolumeUpload(tech, patientId, "abdomen.nii.gz", volume, "application/gzip");
        String uploadId = completed.get("uploadId").asString();
        assertThat(completed.get("status").asString()).isEqualTo("UPLOADED");
        assertThat(completed.get("inputType").asString()).isEqualTo("NIFTI");
        assertThat(completed.get("progress").asInt()).isZero();
        assertThat(completed.get("studyId").isNull()).isTrue();

        // the dispatch is stored with the upload, then relayed with exactly the contract fields
        Map<String, Object> row = jdbc.queryForMap("select * from outbox_message where aggregate_id = ?::uuid", uploadId);
        assertThat(row).containsEntry("type", "INGEST_DISPATCH");
        Map<String, String> msg = awaitIngestMessage(uploadId, 1);
        assertThat(msg.keySet()).containsExactlyInAnyOrder("uploadId", "attempt", "inputType", "inputUri", "outputPrefix",
                "modalityHint", "bodyPartHint", "enqueuedAt");
        assertThat(msg).containsEntry("attempt", "1").containsEntry("inputType", "NIFTI")
                .containsEntry("modalityHint", "CT").containsEntry("bodyPartHint", "");
        assertThat(msg.get("inputUri")).startsWith("s3://medimg/uploads/" + uploadId + "/").endsWith("/abdomen.nii.gz");
        assertThat(msg.get("outputPrefix")).matches("s3://medimg/studies/[0-9a-f-]{36}/series/[0-9a-f-]{36}/");
        await().atMost(Duration.ofSeconds(5)).until(() -> "imaging.jobs".equals(jdbc.queryForObject(
                "select stream from outbox_message where aggregate_id = ?::uuid", String.class, uploadId)));

        ingestResult(uploadId, 1, "STARTED", Map.of());
        ingestResult(uploadId, 1, "PROGRESS", Map.of("progress", "40"));
        await().atMost(Duration.ofSeconds(10)).until(() -> get("/uploads/" + uploadId, tech).body().get("progress").asInt() == 40);
        assertThat(get("/uploads/" + uploadId, tech).body().get("status").asString()).isEqualTo("PROCESSING");

        String prefix = msg.get("outputPrefix");
        ingestResult(uploadId, 1, "DONE", Map.of("payload", volumePayload(prefix)));
        await().atMost(Duration.ofSeconds(10)).until(() -> "DONE".equals(get("/uploads/" + uploadId, tech).body().get("status").asString()));

        JsonNode done = get("/uploads/" + uploadId, tech).body();
        assertThat(done.get("progress").asInt()).isEqualTo(100);
        String studyId = done.get("studyId").asString();
        assertThat(prefix).startsWith("s3://medimg/studies/" + studyId + "/series/");
        JsonNode study = get("/studies/" + studyId, tech).body();
        assertThat(study.get("inputType").asString()).isEqualTo("NIFTI");
        assertThat(study.get("modality").asString()).isEqualTo("CT");
        JsonNode series = study.get("series").get(0);
        assertThat(prefix).endsWith("/series/" + series.get("id").asString() + "/");
        assertThat(series.get("imageUrl").isNull()).isTrue();
        assertThat(series.get("volumeUrl").asString()).contains("/volume.nii.gz");
        assertThat(series.get("thumbnailUrl").asString()).contains("/thumb.png");
        assertThat(series.get("dims").toString()).isEqualTo("[512,512,301]");
        assertThat(series.get("spacing").toString()).isEqualTo("[0.78,0.78,1.5]");
        assertThat(series.get("numImages").asInt()).isEqualTo(301);
        assertThat(series.get("modality").asString()).isEqualTo("CT");

        // the raw upload is deleted; later messages for the finished upload change nothing
        String rawKey = storage.keyOf(msg.get("inputUri"));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThatThrownBy(() -> storage.size(rawKey)).isInstanceOf(ObjectNotFoundException.class));
        ingestResult(uploadId, 1, "FAILED", Map.of("error", "late", "retryable", "false"));
        await().during(Duration.ofMillis(800)).atMost(Duration.ofSeconds(3))
                .until(() -> "DONE".equals(get("/uploads/" + uploadId, tech).body().get("status").asString()));
    }

    @Test
    void dicomZipIsRetriedAfterARetryableFailureAndFailsWithTheWorkerMessage() throws Exception {
        String tech = login("tech");
        String patientId = createCase(tech);

        JsonNode completed = startVolumeUpload(tech, patientId, "series.zip", TestFiles.zip(), "application/x-zip-compressed");
        String uploadId = completed.get("uploadId").asString();
        assertThat(completed.get("inputType").asString()).isEqualTo("DICOM_SERIES");
        Map<String, String> first = awaitIngestMessage(uploadId, 1);
        assertThat(first).containsEntry("inputType", "DICOM_SERIES");

        ingestResult(uploadId, 1, "STARTED", Map.of());
        ingestResult(uploadId, 1, "FAILED", Map.of("error", "S3 timeout", "retryable", "true"));
        Map<String, String> second = awaitIngestMessage(uploadId, 2);
        assertThat(second.get("outputPrefix")).isEqualTo(first.get("outputPrefix"));
        JsonNode retrying = get("/uploads/" + uploadId, tech).body();
        assertThat(retrying.get("status").asString()).isEqualTo("UPLOADED");
        assertThat(retrying.get("error").isNull()).isTrue();

        // a late DONE of attempt 1 is ignored
        ingestResult(uploadId, 1, "DONE", Map.of("payload", volumePayload(first.get("outputPrefix"))));
        ingestResult(uploadId, 2, "FAILED", Map.of("error", "Series has 12 slices; at least 20 are needed", "retryable", "false"));

        await().atMost(Duration.ofSeconds(10)).until(() -> "FAILED".equals(get("/uploads/" + uploadId, tech).body().get("status").asString()));
        JsonNode failed = get("/uploads/" + uploadId, tech).body();
        assertThat(failed.get("error").asString()).isEqualTo("Series has 12 slices; at least 20 are needed");
        assertThat(failed.get("studyId").isNull()).isTrue();
        assertThat(ingestMessages(uploadId)).hasSize(2);
        String rawKey = storage.keyOf(first.get("inputUri"));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThatThrownBy(() -> storage.size(rawKey)).isInstanceOf(ObjectNotFoundException.class));
    }

    @Test
    void contentMustMatchTheDeclaredKindAndSizeLimitsDependOnIt() throws Exception {
        String tech = login("tech");
        String patientId = createCase(tech);

        JsonNode pngAsVolume = startVolumeUpload(tech, patientId, "fake.nii.gz", png(300, 300), "application/gzip");
        assertThat(pngAsVolume.get("status").asString()).isEqualTo("FAILED");
        assertThat(pngAsVolume.get("error").asString()).contains("neither a ZIP archive").contains("NIfTI");
        assertThat(pngAsVolume.get("inputType").isNull()).isTrue();

        JsonNode volumeAsPng = startVolumeUpload(tech, patientId, "scan.png", TestFiles.nifti1(), "image/png");
        assertThat(volumeAsPng.get("status").asString()).isEqualTo("FAILED");
        assertThat(volumeAsPng.get("error").asString()).contains("not a PNG or JPEG");

        assertThat(init(tech, patientId, "big.zip", 500L * 1024 * 1024, "application/zip").status()).isEqualTo(201);
        assertThat(init(tech, patientId, "huge.zip", 500L * 1024 * 1024 + 1, "application/zip").status()).isEqualTo(400);
        assertThat(init(tech, patientId, "big.png", 50L * 1024 * 1024 + 1, "image/png").status()).isEqualTo(400);
        assertThat(init(tech, patientId, "ct.nii", 1000, "application/octet-stream").status()).isEqualTo(201);
        Response wrongType = init(tech, patientId, "ct.nii.gz", 1000, "image/png");
        assertThat(wrongType.status()).isEqualTo(201); // declared a PNG; its content decides at complete
        Response zipAsGzip = init(tech, patientId, "series.zip", 1000, "application/gzip");
        assertThat(zipAsGzip.status()).isEqualTo(400);
        assertThat(zipAsGzip.body().get("detail").asString()).contains(".nii.gz");
    }

    @Test
    void malformedAndUnparseableMessagesAreHandled() throws Exception {
        String tech = login("tech");
        String uploadId = startVolumeUpload(tech, createCase(tech), "ct.nii", TestFiles.nifti1(), "application/octet-stream")
                .get("uploadId").asString();
        awaitIngestMessage(uploadId, 1);

        redis.opsForStream().add("imaging.results", Map.of("uploadId", "not-a-uuid", "attempt", "1", "type", "DONE"));
        await().atMost(Duration.ofSeconds(10)).until(() -> redis.opsForStream()
                .range("imaging.results.dlq", Range.unbounded()).stream()
                .anyMatch(r -> "not-a-uuid".equals(r.getValue().get("uploadId"))));

        // the worker could not parse the job message, so it does not know the attempt
        ingestResult(uploadId, 0, "FAILED", Map.of("error", "attempt is not an integer: 'x'", "retryable", "false"));
        await().atMost(Duration.ofSeconds(10)).until(() -> "FAILED".equals(get("/uploads/" + uploadId, tech).body().get("status").asString()));
        assertThat(get("/uploads/" + uploadId, tech).body().get("error").asString()).contains("attempt is not an integer");
    }

    @Test
    void unreadableDonePayloadFailsTheUpload() throws Exception {
        String tech = login("tech");
        String uploadId = startVolumeUpload(tech, createCase(tech), "ct.nii", TestFiles.nifti1(), "application/octet-stream")
                .get("uploadId").asString();
        awaitIngestMessage(uploadId, 1);

        ingestResult(uploadId, 1, "DONE", Map.of("payload", volumePayload("s3://medimg/studies/elsewhere/")));

        await().atMost(Duration.ofSeconds(10)).until(() -> "FAILED".equals(get("/uploads/" + uploadId, tech).body().get("status").asString()));
        assertThat(get("/uploads/" + uploadId, tech).body().get("error").asString()).contains("unreadable result");
    }

    @Test
    void volumesHaveTheirOwnProcessingTimeout() throws Exception {
        doThrow(new RedisConnectionFailureException("Redis is down")).when(streams).publish(eq("imaging.jobs"), any());
        String tech = login("tech");
        String patientId = createCase(tech);
        String silent = startVolumeUpload(tech, patientId, "ct.nii", TestFiles.nifti1(), "application/octet-stream")
                .get("uploadId").asString();
        String slow = startVolumeUpload(tech, patientId, "ct.nii", TestFiles.nifti1(), "application/octet-stream")
                .get("uploadId").asString();
        jdbc.update("update upload_session set updated_at = now() - interval '31 minutes' where id = ?::uuid", silent);
        jdbc.update("update upload_session set updated_at = now() - interval '11 minutes' where id = ?::uuid", slow);

        assertThat(sweeper.failStaleUploads()).isPositive();

        JsonNode failed = get("/uploads/" + silent, tech).body();
        assertThat(failed.get("status").asString()).isEqualTo("FAILED");
        assertThat(failed.get("error").asString()).contains("upload the volume again");
        assertThat(jdbc.queryForObject("select count(*) from outbox_message where aggregate_id = ?::uuid and published_at is null",
                Long.class, silent)).isZero();
        assertThat(get("/uploads/" + slow, tech).body().get("status").asString()).isEqualTo("UPLOADED");
    }

    private Response init(String token, String patientId, String name, long size, String contentType) {
        return post("/uploads/init", token, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", name, "size", size, "contentType", contentType))));
    }
}
