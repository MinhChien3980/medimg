package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.StreamSupport;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/** Doctors review the AI findings of a study and add findings by hand; everyone else only reads them. */
class FindingReviewIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void doctorReviewsAiFindingsWithOptimisticLocking() throws Exception {
        String doctor = login("doctor");
        String[] study = uploadStudy(doctor, createCase(doctor));
        String jobId = completedPrediction(doctor, study, "cxr-multilabel", """
                [{"label":"Effusion","confidence":0.81},{"label":"Cardiomegaly","confidence":0.62},
                 {"label":"Nodule","confidence":0.2}]""");

        Response pending = get("/studies/" + study[0] + "/findings", doctor);
        assertThat(pending.status()).isEqualTo(200);
        Map<String, JsonNode> byLabel = byLabel(pending.body());
        assertThat(byLabel).containsOnlyKeys("Effusion", "Cardiomegaly", "Nodule");
        JsonNode effusion = byLabel.get("Effusion");
        assertThat(effusion.get("source").asString()).isEqualTo("AI");
        assertThat(effusion.get("reviewStatus").asString()).isEqualTo("PENDING");
        assertThat(effusion.get("review").isNull()).isTrue();
        assertThat(effusion.get("seriesId").asString()).isEqualTo(study[1]);
        assertThat(effusion.get("version").asLong()).isZero();

        Response accepted = review(doctor, effusion, Map.of("status", "ACCEPTED", "note", "right side", "version", 0));
        assertThat(accepted.status()).isEqualTo(200);
        assertThat(accepted.body().get("reviewStatus").asString()).isEqualTo("ACCEPTED");
        JsonNode review = accepted.body().get("review");
        assertThat(review.get("status").asString()).isEqualTo("ACCEPTED");
        assertThat(review.get("note").asString()).isEqualTo("right side");
        assertThat(review.get("label").isNull()).isTrue();
        assertThat(review.get("reviewedBy").get("fullName").asString()).isEqualTo("Demo Doctor");
        assertThat(review.get("reviewedAt").isNull()).isFalse();
        assertThat(accepted.body().get("version").asLong()).isEqualTo(1);

        // a review made on a version that has changed since is rejected
        Response stale = review(doctor, effusion, Map.of("status", "REJECTED", "version", 0));
        assertThat(stale.status()).isEqualTo(409);

        JsonNode cardiomegaly = byLabel.get("Cardiomegaly");
        assertThat(review(doctor, cardiomegaly, Map.of("status", "EDITED", "version", 0)).status()).isEqualTo(400);
        assertThat(review(doctor, cardiomegaly, Map.of("status", "ACCEPTED", "label", "x", "version", 0)).status())
                .isEqualTo(400);
        assertThat(review(doctor, cardiomegaly, Map.of("status", "MAYBE", "version", 0)).status()).isEqualTo(400);
        Response edited = review(doctor, cardiomegaly, Map.of("status", "EDITED", "label", "Enlarged heart", "version", 0));
        assertThat(edited.status()).isEqualTo(200);
        assertThat(edited.body().get("review").get("label").asString()).isEqualTo("Enlarged heart");
        assertThat(edited.body().get("label").asString()).isEqualTo("Cardiomegaly");
        assertThat(review(doctor, byLabel.get("Nodule"), Map.of("status", "REJECTED", "version", 0)).status())
                .isEqualTo(200);

        Response confirmed = get("/studies/" + study[0] + "/findings?status=ACCEPTED&status=EDITED", doctor);
        assertThat(byLabel(confirmed.body())).containsOnlyKeys("Effusion", "Cardiomegaly");
        assertThat(get("/studies/" + study[0] + "/findings?status=MAYBE", doctor).status()).isEqualTo(400);
        assertThat(get("/studies/" + UUID.randomUUID() + "/findings", doctor).status()).isEqualTo(404);
        assertThat(review(doctor, UUID.randomUUID().toString(), Map.of("status", "ACCEPTED", "version", 0))
                .status()).isEqualTo(404);

        // the prediction shows the reviews too
        JsonNode job = get("/predictions/" + jobId, doctor).body();
        assertThat(byLabel(job.get("findings")).get("Cardiomegaly").get("review").get("status").asString())
                .isEqualTo("EDITED");

        awaitAudit("FINDING_REVIEWED", effusion.get("id").asString());
    }

    @Test
    void onlyDoctorsReviewWhileEveryRoleReads() throws Exception {
        String doctor = login("doctor");
        String[] study = uploadStudy(doctor, createCase(doctor));
        completedPrediction(doctor, study, "cxr-multilabel", "[{\"label\":\"Effusion\",\"confidence\":0.81}]");
        JsonNode finding = get("/studies/" + study[0] + "/findings", doctor).body().get(0);
        Map<String, Object> accept = Map.of("status", "ACCEPTED", "version", 0);

        for (String user : List.of("tech", "admin", "researcher")) {
            String token = login(user);
            assertThat(get("/studies/" + study[0] + "/findings", token).status()).isEqualTo(200);
            assertThat(review(token, finding, accept).status()).isEqualTo(403);
            assertThat(post("/studies/" + study[0] + "/findings", token,
                    Map.of("seriesId", study[1], "label", "Fracture")).status()).isEqualTo(403);
        }
    }

    @Test
    void doctorAddsAFindingByHandAndDeletesItWhileNoFinalReportCitesIt() throws Exception {
        String doctor = login("doctor");
        String[] study = uploadStudy(doctor, createCase(doctor));
        completedPrediction(doctor, study, "cxr-multilabel", "[{\"label\":\"Effusion\",\"confidence\":0.81}]");
        String annotationId = post("/studies/" + study[0] + "/annotations", doctor, Map.of("seriesId", study[1],
                "kind", "RECTANGLE", "geometry", Map.of("x", 10, "y", 10, "width", 40, "height", 30)))
                .body().get("id").asString();

        Response added = post("/studies/" + study[0] + "/findings", doctor, Map.of("seriesId", study[1],
                "label", " Rib fracture ", "note", "left 5th rib", "annotationId", annotationId));
        assertThat(added.status()).isEqualTo(201);
        JsonNode manual = added.body();
        assertThat(manual.get("source").asString()).isEqualTo("MANUAL");
        assertThat(manual.get("label").asString()).isEqualTo("Rib fracture");
        assertThat(manual.get("reviewStatus").asString()).isEqualTo("ACCEPTED");
        assertThat(manual.get("confidence").isNull()).isTrue();
        assertThat(manual.get("annotationId").asString()).isEqualTo(annotationId);
        assertThat(manual.get("review").get("note").asString()).isEqualTo("left 5th rib");
        assertThat(manual.get("review").get("reviewedBy").get("fullName").asString()).isEqualTo("Demo Doctor");

        assertThat(post("/studies/" + study[0] + "/findings", doctor, Map.of("seriesId", study[1], "label", " ")).status())
                .isEqualTo(400);
        assertThat(post("/studies/" + study[0] + "/findings", doctor, Map.of("seriesId", UUID.randomUUID(),
                "label", "x")).status()).isEqualTo(404);
        assertThat(post("/studies/" + study[0] + "/findings", doctor, Map.of("seriesId", study[1], "label", "x",
                "annotationId", UUID.randomUUID())).status()).isEqualTo(404);

        // a finding added by hand is accepted when added and not reviewed
        assertThat(review(doctor, manual, Map.of("status", "REJECTED", "version", 0)).status()).isEqualTo(409);

        Response accepted = get("/studies/" + study[0] + "/findings?status=ACCEPTED", doctor);
        assertThat(accepted.body().size()).isEqualTo(1);
        assertThat(accepted.body().get(0).get("source").asString()).isEqualTo("MANUAL");

        // AI findings are never deleted; nor is a finding added by hand by somebody else (only doctors are authors)
        JsonNode ai = get("/studies/" + study[0] + "/findings?status=PENDING", doctor).body().get(0);
        assertThat(call("DELETE", "/findings/" + ai.get("id").asString(), doctor, null, Map.of()).status()).isEqualTo(403);
        assertThat(call("DELETE", "/findings/" + manual.get("id").asString(), login("tech"), null, Map.of()).status())
                .isEqualTo(403);

        // deleting the annotation keeps the finding, without its annotation
        assertThat(call("DELETE", "/annotations/" + annotationId, doctor, null, Map.of()).status()).isEqualTo(204);
        assertThat(get("/studies/" + study[0] + "/findings?status=ACCEPTED", doctor).body().get(0).get("annotationId")
                .isNull()).isTrue();

        assertThat(call("DELETE", "/findings/" + manual.get("id").asString(), doctor, null, Map.of()).status())
                .isEqualTo(204);
        assertThat(get("/studies/" + study[0] + "/findings?status=ACCEPTED", doctor).body().size()).isZero();

        awaitAudit("FINDING_ADDED", manual.get("id").asString());
        awaitAudit("FINDING_DELETED", manual.get("id").asString());
    }

    private Response review(String token, JsonNode finding, Map<String, Object> body) {
        return review(token, finding.get("id").asString(), body);
    }

    private Response review(String token, String findingId, Map<String, Object> body) {
        return call("PATCH", "/findings/" + findingId + "/review", token, body, Map.of());
    }

    private static Map<String, JsonNode> byLabel(JsonNode findings) {
        Map<String, JsonNode> map = new HashMap<>();
        StreamSupport.stream(findings.spliterator(), false).forEach(f -> map.put(f.get("label").asString(), f));
        return map;
    }

    private void awaitAudit(String action, String resourceId) {
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = ? and resource_id = ? and outcome = 'SUCCESS'", Long.class,
                action, resourceId) == 1);
    }
}
