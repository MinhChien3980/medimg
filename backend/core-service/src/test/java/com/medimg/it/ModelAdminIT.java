package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/** Model administration; each test uses models of its own so that the seeded ones stay active for the other tests. */
class ModelAdminIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    /** The models of these tests must not show up in the model lists of the other tests. */
    @AfterEach
    void retireTestModels() {
        jdbc.update("update ai_model set status = 'RETIRED' where code like 'it-%'");
    }

    private String insertModel(String status) {
        String id = UUID.randomUUID().toString();
        String code = "it-" + id.substring(0, 8);
        jdbc.update("""
                insert into ai_model (id, code, version, name, task, input_types, modality, labels, status)
                values (?::uuid, ?, '1.0', 'IT model', 'CLASSIFICATION_2D', 'IMAGE_2D', null, '["A","B"]', ?)
                """, id, code, status);
        return id;
    }

    private JsonNode adminModel(String admin, String id) {
        for (JsonNode m : get("/admin/models", admin).body()) {
            if (m.get("id").asString().equals(id)) {
                return m;
            }
        }
        return null;
    }

    private List<String> offeredCodes(String token) {
        List<String> out = new ArrayList<>();
        get("/models", token).body().forEach(m -> out.add(m.get("code").asString()));
        return out;
    }

    @Test
    void onlyAdminsAdministerModels() {
        String id = insertModel("ACTIVE");
        assertThat(get("/admin/models", login("doctor")).status()).isEqualTo(403);
        assertThat(post("/admin/models/" + id + "/disable", login("tech"), null).status()).isEqualTo(403);
        assertThat(post("/admin/models/" + id + "/enable", login("researcher"), null).status()).isEqualTo(403);
        assertThat(get("/admin/models", null).status()).isEqualTo(401);
    }

    @Test
    void listsEveryModelWithItsStatus() {
        String staging = insertModel("STAGING");
        JsonNode models = get("/admin/models", login("admin")).body();
        List<String> codes = new ArrayList<>();
        models.forEach(m -> codes.add(m.get("code").asString()));
        assertThat(codes).contains("cxr-multilabel", "ct-totalseg");
        JsonNode cxr = models.get(codes.indexOf("cxr-multilabel"));
        assertThat(cxr.get("inputTypes").toString()).isEqualTo("[\"IMAGE_2D\",\"DICOM_2D\"]");
        assertThat(cxr.get("modality").asString()).isEqualTo("CR,DX");
        assertThat(cxr.get("status").asString()).isEqualTo("ACTIVE");
        assertThat(cxr.get("stats").has("jobs")).isTrue();
        JsonNode unused = adminModel(login("admin"), staging);
        assertThat(unused.get("status").asString()).isEqualTo("STAGING");
        assertThat(unused.get("stats").get("jobs").asLong()).isZero();
        assertThat(unused.get("stats").get("avgInferenceMs").isNull()).isTrue();
        assertThat(unused.get("stats").get("lastUsedAt").isNull()).isTrue();
    }

    @Test
    void aDisabledModelIsHiddenAndTakesNoNewJobButRunningJobsFinish() throws Exception {
        String admin = login("admin");
        String tech = login("tech");
        String id = insertModel("ACTIVE");
        String code = jdbc.queryForObject("select code from ai_model where id = ?::uuid", String.class, id);
        String[] study = uploadStudy(tech, createCase(tech));
        String running = post("/predictions", tech, Map.of("studyId", study[0], "seriesId", study[1], "modelCode", code))
                .body().get("jobId").asString();
        String failing = post("/predictions", tech, Map.of("studyId", study[0], "seriesId", study[1], "modelCode", code))
                .body().get("jobId").asString();
        assertThat(offeredCodes(tech)).contains(code);

        JsonNode disabled = post("/admin/models/" + id + "/disable", admin, null).body();
        assertThat(disabled.get("status").asString()).isEqualTo("DISABLED");
        assertThat(post("/admin/models/" + id + "/disable", admin, null).body().get("status").asString()).isEqualTo("DISABLED");

        assertThat(offeredCodes(tech)).doesNotContain(code);
        assertThat(offeredCodes(tech)).contains("cxr-multilabel");
        Response refused = post("/predictions", tech, Map.of("studyId", study[0], "seriesId", study[1], "modelCode", code));
        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.body().get("detail").asString()).isEqualTo("Model " + code + " is disabled");
        assertThat(refused.body().get("type").asString()).isEqualTo("/problems/model-disabled");

        // jobs queued before go on
        workerResult(running, 1, "DONE", Map.of("payload", "{\"inferenceMs\":240,\"findings\":[]}"));
        workerResult(failing, 1, "FAILED", Map.of("error", "bad image", "retryable", "false"));
        await().atMost(Duration.ofSeconds(10)).until(() ->
                "DONE".equals(get("/predictions/" + running, tech).body().get("status").asString())
                        && "FAILED".equals(get("/predictions/" + failing, tech).body().get("status").asString()));
        // but a failed one is not retried by hand on a disabled model
        Response retry = post("/predictions/" + failing + "/retry", tech, null);
        assertThat(retry.status()).isEqualTo(422);
        assertThat(retry.body().get("type").asString()).isEqualTo("/problems/model-disabled");

        JsonNode stats = adminModel(admin, id).get("stats");
        assertThat(stats.get("jobs").asLong()).isEqualTo(2);
        assertThat(stats.get("done").asLong()).isEqualTo(1);
        assertThat(stats.get("failed").asLong()).isEqualTo(1);
        assertThat(stats.get("avgInferenceMs").asLong()).isEqualTo(240);
        assertThat(stats.get("p95InferenceMs").asLong()).isEqualTo(240);
        assertThat(stats.get("lastUsedAt").isNull()).isFalse();

        assertThat(post("/admin/models/" + id + "/enable", admin, null).body().get("status").asString()).isEqualTo("ACTIVE");
        assertThat(offeredCodes(tech)).contains(code);
        assertThat(post("/predictions", tech, Map.of("studyId", study[0], "seriesId", study[1], "modelCode", code)).status())
                .isEqualTo(202);
        assertThat(post("/predictions/" + failing + "/retry", tech, null).status()).isEqualTo(200);

        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForList(
                "select action from audit_log where resource_type = 'MODEL' and resource_id = ? order by id", String.class, id)
                .equals(List.of("MODEL_DISABLED", "MODEL_ENABLED")));
    }

    @Test
    void stagingModelsCannotBeToggledAndUnknownOnesAreNotFound() {
        String admin = login("admin");
        String staging = insertModel("STAGING");
        Response r = post("/admin/models/" + staging + "/enable", admin, null);
        assertThat(r.status()).isEqualTo(409);
        assertThat(r.body().get("type").asString()).isEqualTo("/problems/model-status");
        assertThat(post("/admin/models/" + staging + "/disable", admin, null).status()).isEqualTo(409);
        assertThat(post("/admin/models/" + UUID.randomUUID() + "/disable", admin, null).status()).isEqualTo(404);
    }
}
