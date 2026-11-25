package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.medimg.support.IntegrationTest;

/** RESEARCHER is read-only: it can browse cases, studies and predictions but not change anything. */
class ResearcherAccessIT extends IntegrationTest {

    @Test
    void researcherCanReadButNotWrite() throws Exception {
        String doctor = login("doctor");
        String patientId = createCase(doctor);
        String[] ids = uploadStudy(doctor, patientId);
        String studyId = ids[0];
        String seriesId = ids[1];
        String jobId = post("/predictions", doctor, Map.of("studyId", studyId, "seriesId", seriesId, "modelCode", "cxr-multilabel"))
                .body().get("jobId").asString();
        String uploadId = post("/uploads/init", doctor, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", "r.png", "size", 10, "contentType", "image/png"))))
                .body().get("uploadId").asString();

        String researcher = login("researcher");

        assertThat(get("/patients", researcher).status()).isEqualTo(200);
        assertThat(get("/patients/" + patientId, researcher).status()).isEqualTo(200);
        assertThat(get("/patients/" + patientId + "/studies", researcher).status()).isEqualTo(200);
        Response study = get("/studies/" + studyId, researcher);
        assertThat(study.status()).isEqualTo(200);
        assertThat(study.body().get("series").get(0).get("imageUrl").asString()).isNotBlank();
        assertThat(study.body().get("series").get(0).get("thumbnailUrl").asString()).isNotBlank();
        assertThat(get("/models", researcher).status()).isEqualTo(200);
        assertThat(get("/studies/" + studyId + "/predictions", researcher).status()).isEqualTo(200);
        assertThat(get("/predictions/" + jobId, researcher).status()).isEqualTo(200);

        assertThat(post("/patients", researcher, Map.of()).status()).isEqualTo(403);
        assertThat(call("PUT", "/patients/" + patientId, researcher, Map.of("sex", "F"), Map.of()).status()).isEqualTo(403);
        assertThat(call("DELETE", "/patients/" + patientId, researcher, null, Map.of()).status()).isEqualTo(403);
        assertThat(post("/uploads/init", researcher, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", "r.png", "size", 10, "contentType", "image/png")))).status()).isEqualTo(403);
        assertThat(post("/uploads/" + uploadId + "/complete", researcher, null).status()).isEqualTo(403);
        assertThat(get("/uploads/" + uploadId, researcher).status()).isEqualTo(403);
        assertThat(post("/predictions", researcher, Map.of("studyId", studyId, "seriesId", seriesId,
                "modelCode", "cxr-multilabel")).status()).isEqualTo(403);
        assertThat(post("/predictions/" + jobId + "/cancel", researcher, null).status()).isEqualTo(403);
        assertThat(post("/predictions/" + jobId + "/retry", researcher, null).status()).isEqualTo(403);

        // a finished job's event stream sends the final state and closes
        assertThat(post("/predictions/" + jobId + "/cancel", doctor, null).status()).isEqualTo(200);
        HttpResponse<String> events = raw.send(HttpRequest.newBuilder(
                        URI.create("http://localhost:" + port + "/api/v1/predictions/" + jobId + "/events"))
                .header("Authorization", "Bearer " + researcher).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(events.statusCode()).isEqualTo(200);
        assertThat(events.body()).contains("event:failed").contains("CANCELLED");
    }
}
