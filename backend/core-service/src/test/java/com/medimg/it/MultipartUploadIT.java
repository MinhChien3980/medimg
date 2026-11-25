package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Random;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.imaging.application.StaleUploadSweeper;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/**
 * Files above the multipart threshold (6 MB here, parts of 5 MB) go to the real SeaweedFS in parts, with presigned
 * UploadPart URLs, as the browser does it.
 */
class MultipartUploadIT extends IntegrationTest {

    private static final int MB = 1024 * 1024;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    ObjectStoragePort storage;

    @Autowired
    StaleUploadSweeper sweeper;

    @Test
    void fileIsUploadedInPartsAndAssembledAtComplete() throws Exception {
        String tech = login("tech");
        byte[] content = zipOf(12 * MB + 123);
        Started upload = init(tech, content);

        JsonNode file = upload.file();
        assertThat(file.get("putUrl").isNull()).isTrue();
        assertThat(file.get("multipart").get("partSize").asLong()).isEqualTo(5L * MB);
        assertThat(file.get("expiresAt").asString()).isNotBlank();
        List<String> urls = partUrls(file);
        assertThat(urls).hasSize(3);

        List<Map<String, Object>> parts = new ArrayList<>();
        for (int n = urls.size(); n >= 1; n--) { // any order
            HttpResponse<String> put = putPart(urls.get(n - 1), slice(content, n));
            assertThat(put.statusCode()).isEqualTo(200);
            String etag = put.headers().firstValue("ETag").orElseThrow();
            assertThat(etag).startsWith("\"").endsWith("\"");
            parts.add(Map.of("partNumber", n, "etag", etag));
        }
        // a part of another size than the one handed out does not match its signature
        assertThat(putPart(urls.getFirst(), Arrays.copyOf(content, 100)).statusCode()).isEqualTo(403);

        Response completed = complete(tech, upload, parts);

        assertThat(completed.status()).isEqualTo(202);
        assertThat(completed.body().get("status").asString()).isEqualTo("UPLOADED");
        Map<String, String> msg = awaitIngestMessage(upload.id(), 1);
        assertThat(msg).containsEntry("inputType", "ZIP");
        String key = storage.keyOf(msg.get("inputUri"));
        assertThat(storage.size(key)).isEqualTo(content.length);
        assertThat(storage.get(key)).isEqualTo(content);
    }

    @Test
    void partsMustBeListedCompletelyAndOnlyForAFileUploadedInParts() throws Exception {
        String tech = login("tech");
        byte[] content = zipOf(11 * MB);
        Started upload = init(tech, content);
        List<String> urls = partUrls(upload.file());
        List<Map<String, Object>> parts = new ArrayList<>();
        for (int n = 1; n <= urls.size(); n++) {
            String etag = putPart(urls.get(n - 1), slice(content, n)).headers().firstValue("ETag").orElseThrow();
            parts.add(Map.of("partNumber", n, "etag", etag));
        }

        Response noParts = post("/uploads/" + upload.id() + "/complete", tech, null);
        assertThat(noParts.status()).isEqualTo(400);
        assertThat(noParts.body().get("detail").asString()).contains("list its parts");
        Response missing = complete(tech, upload, parts.subList(0, 2));
        assertThat(missing.status()).isEqualTo(400);
        assertThat(missing.body().get("detail").asString()).contains("has 3 parts");
        assertThat(complete(tech, upload, List.of(Map.of("partNumber", 0, "etag", "x"))).status()).isEqualTo(400);
        assertThat(get("/uploads/" + upload.id(), tech).body().get("status").asString()).isEqualTo("INIT");

        // still INIT: the client can complete with the right list
        assertThat(complete(tech, upload, parts).body().get("status").asString()).isEqualTo("UPLOADED");

        byte[] small = zipOf(1000);
        Started single = init(tech, small);
        putObject(single.file().get("putUrl").asString(), small, "application/zip");
        Response withParts = complete(tech, single, List.of(Map.of("partNumber", 1, "etag", "\"x\"")));
        assertThat(withParts.status()).isEqualTo(400);
        assertThat(withParts.body().get("detail").asString()).contains("not uploaded in parts");
    }

    @Test
    void partsTheStorageRejectsFailTheUploadAndAbortIt() throws Exception {
        String tech = login("tech");
        byte[] content = zipOf(7 * MB);
        Started upload = init(tech, content);
        List<String> urls = partUrls(upload.file());
        putPart(urls.get(0), slice(content, 1)); // part 2 is never uploaded

        Response completed = complete(tech, upload, List.of(Map.of("partNumber", 1, "etag", "\"0123\""),
                Map.of("partNumber", 2, "etag", "\"4567\"")));

        assertThat(completed.status()).isEqualTo(202);
        assertThat(completed.body().get("status").asString()).isEqualTo("FAILED");
        assertThat(completed.body().get("error").asString()).contains("rejected the uploaded parts");
        awaitAborted(urls.get(1), slice(content, 2));
    }

    @Test
    void multipartUploadNeverCompletedIsAbortedBySweeper() throws Exception {
        String tech = login("tech");
        byte[] content = zipOf(7 * MB);
        Started upload = init(tech, content);
        List<String> urls = partUrls(upload.file());
        assertThat(putPart(urls.get(0), slice(content, 1)).statusCode()).isEqualTo(200);
        jdbc.update("update upload_session set created_at = now() - interval '3 hours' where id = ?::uuid", upload.id());

        assertThat(sweeper.abortAbandonedMultipartUploads()).isPositive();

        JsonNode failed = get("/uploads/" + upload.id(), tech).body();
        assertThat(failed.get("status").asString()).isEqualTo("FAILED");
        assertThat(failed.get("error").asString()).contains("not completed in time");
        awaitAborted(urls.get(1), slice(content, 2));
        assertThat(sweeper.abortAbandonedMultipartUploads()).isZero();
    }

    private record Started(String id, JsonNode file) {
    }

    private Started init(String token, byte[] content) {
        Response init = post("/uploads/init", token, Map.of("patientId", createCase(token),
                "files", List.of(Map.of("name", "big.zip", "size", content.length, "contentType", "application/zip"))));
        assertThat(init.status()).isEqualTo(201);
        return new Started(init.body().get("uploadId").asString(), init.body().get("files").get(0));
    }

    private Response complete(String token, Started upload, List<Map<String, Object>> parts) {
        return post("/uploads/" + upload.id() + "/complete", token, Map.of("files",
                List.of(Map.of("fileId", upload.file().get("fileId").asString(), "parts", parts))));
    }

    private static List<String> partUrls(JsonNode file) {
        List<String> urls = new ArrayList<>();
        for (JsonNode part : file.get("multipart").get("parts")) {
            assertThat(part.get("partNumber").asInt()).isEqualTo(urls.size() + 1);
            urls.add(part.get("url").asString());
        }
        return urls;
    }

    /** As the browser sends a slice of the file: no Content-Type. */
    private HttpResponse<String> putPart(String url, byte[] part) throws IOException, InterruptedException {
        return raw.send(HttpRequest.newBuilder(URI.create(url)).PUT(HttpRequest.BodyPublishers.ofByteArray(part)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    /** Once the multipart upload is aborted, its part URLs are refused. */
    private void awaitAborted(String partUrl, byte[] part) {
        await().atMost(Duration.ofSeconds(5)).until(() -> putPart(partUrl, part).statusCode() == 404);
    }

    private static byte[] slice(byte[] content, int partNumber) {
        int from = (partNumber - 1) * 5 * MB;
        return Arrays.copyOfRange(content, from, Math.min(content.length, from + 5 * MB));
    }

    /** Random bytes behind the ZIP signature: only the first bytes are checked at complete. */
    private static byte[] zipOf(int size) {
        byte[] content = new byte[size];
        new Random(size).nextBytes(content);
        content[0] = 'P';
        content[1] = 'K';
        content[2] = 3;
        content[3] = 4;
        return content;
    }
}
