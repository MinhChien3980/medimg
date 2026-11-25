package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.Map;
import java.util.stream.StreamSupport;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/** An admin marks cases as samples; every role, RESEARCHER included, sees them on the samples page. */
class SampleCasesIT extends IntegrationTest {

    private static final Map<String, String> SAMPLE = Map.of("title", "Abdomen CT", "description", "Portal venous phase",
            "source", "TotalSegmentator dataset (Zenodo 10047263), CC BY 4.0");

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void adminMarksASampleThatEveryRoleSees() throws Exception {
        String admin = login("admin");
        String patientId = createCase(admin);
        String[] study = uploadVolumeStudy(admin, patientId);
        String jobId = post("/predictions", admin, Map.of("studyId", study[0], "seriesId", study[1], "modelCode", "ct-totalseg"))
                .body().get("jobId").asString();

        Response marked = call("PUT", "/patients/" + patientId + "/sample", admin, SAMPLE, Map.of());

        assertThat(marked.status()).isEqualTo(200);
        assertThat(marked.body().get("sample").get("title").asString()).isEqualTo("Abdomen CT");
        assertThat(marked.body().get("studyCount").asLong()).isEqualTo(1);
        assertThat(get("/patients/" + patientId, admin).body().get("sample").get("source").asString()).contains("CC BY 4.0");

        JsonNode sample = sampleOf(get("/samples", login("researcher")), patientId);
        assertThat(sample.get("code").asString()).isEqualTo(marked.body().get("code").asString());
        assertThat(sample.get("description").asString()).isEqualTo("Portal venous phase");
        JsonNode sampleStudy = sample.get("studies").get(0);
        assertThat(sampleStudy.get("studyId").asString()).isEqualTo(study[0]);
        assertThat(sampleStudy.get("inputType").asString()).isEqualTo("NIFTI");
        assertThat(sampleStudy.get("modality").asString()).isEqualTo("CT");
        assertThat(sampleStudy.get("thumbnailUrl").asString()).contains("/thumb.png");
        assertThat(sampleStudy.get("latestPrediction").get("jobId").asString()).isEqualTo(jobId);
        assertThat(sampleStudy.get("latestPrediction").get("modelCode").asString()).isEqualTo("ct-totalseg");
        assertThat(sampleStudy.get("latestPrediction").get("status").asString()).isEqualTo("QUEUED");

        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'SAMPLE_MARKED' and resource_id = ?", Long.class, patientId) == 1);

        assertThat(call("DELETE", "/patients/" + patientId + "/sample", admin, null, Map.of()).status()).isEqualTo(204);
        assertThat(get("/patients/" + patientId, admin).body().get("sample").isNull()).isTrue();
        assertThat(sampleOf(get("/samples", admin), patientId)).isNull();
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'SAMPLE_UNMARKED' and resource_id = ?", Long.class, patientId) == 1);
    }

    @Test
    void onlyAdminsMarkSamplesAndDeletedCasesAreNotListed() {
        String admin = login("admin");
        String doctor = login("doctor");
        String researcher = login("researcher");
        String patientId = createCase(doctor);

        assertThat(call("PUT", "/patients/" + patientId + "/sample", doctor, SAMPLE, Map.of()).status()).isEqualTo(403);
        assertThat(call("PUT", "/patients/" + patientId + "/sample", researcher, SAMPLE, Map.of()).status()).isEqualTo(403);
        assertThat(call("DELETE", "/patients/" + patientId + "/sample", doctor, null, Map.of()).status()).isEqualTo(403);
        assertThat(call("PUT", "/patients/" + patientId + "/sample", admin, Map.of("title", "No source"), Map.of()).status())
                .isEqualTo(400);
        assertThat(call("PUT", "/patients/" + patientId + "/sample", admin,
                Map.of("title", "x".repeat(121), "source", "s"), Map.of()).status()).isEqualTo(400);
        assertThat(get("/samples", null).status()).isEqualTo(401);

        assertThat(call("PUT", "/patients/" + patientId + "/sample", admin, SAMPLE, Map.of()).status()).isEqualTo(200);
        JsonNode listed = sampleOf(get("/samples", doctor), patientId);
        assertThat(listed.get("studies").isEmpty()).isTrue();

        assertThat(call("DELETE", "/patients/" + patientId, admin, null, Map.of()).status()).isEqualTo(204);
        assertThat(sampleOf(get("/samples", doctor), patientId)).isNull();
        assertThat(call("PUT", "/patients/" + patientId + "/sample", admin, SAMPLE, Map.of()).status()).isEqualTo(404);
    }

    /** The entry of the case on the samples page, or null; other tests may have marked samples too. */
    private static JsonNode sampleOf(Response samples, String patientId) {
        assertThat(samples.status()).isEqualTo(200);
        return StreamSupport.stream(samples.body().spliterator(), false)
                .filter(s -> patientId.equals(s.get("patientId").asString()))
                .findFirst().orElse(null);
    }
}
