package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/**
 * Dashboard figures against a dataset written straight into the tables in March 2021, a range no other test touches.
 * The dashboard zone is Asia/Ho_Chi_Minh (UTC+7): 2021-03-01 local runs from 2021-02-28T17:00Z to 2021-03-01T17:00Z.
 */
class DashboardIT extends IntegrationTest {

    private static final String CXR = "6f9a3c1e-0b1d-4c55-9a51-7c2f1e0a0001";
    private static final String CT = "6f9a3c1e-0b1d-4c55-9a51-7c2f1e0a0002";
    private static boolean seeded;

    @Autowired
    JdbcTemplate jdbc;

    @BeforeEach
    void seed() {
        synchronized (DashboardIT.class) {
            if (seeded) {
                return;
            }
            seeded = true;
        }
        // cases: P0 and P9 just outside the range, P4 deleted
        String p0 = patient("2021-02-28T16:59:59Z", false); // 2021-02-28 23:59:59 local
        String p1 = patient("2021-02-28T17:00:00Z", false); // 2021-03-01 00:00 local
        String p2 = patient("2021-03-01T16:59:59Z", false); // 2021-03-01 23:59:59 local
        String p3 = patient("2021-03-01T17:00:00Z", false); // 2021-03-02 00:00 local
        String p4 = patient("2021-03-03T03:00:00Z", true);
        patient("2021-03-07T17:00:00Z", false);              // 2021-03-08 00:00 local

        String[] s0 = study(p0, "IMAGE_2D", "2021-02-27T00:00:00Z");
        String[] s1 = study(p1, "IMAGE_2D", "2021-03-01T02:00:00Z");
        String[] s2 = study(p2, "IMAGE_2D", "2021-03-02T02:00:00Z");
        String[] s3 = study(p3, "NIFTI", "2021-03-02T05:00:00Z");
        String[] s4 = study(p4, "IMAGE_2D", "2021-03-03T04:00:00Z");

        String j1 = job(s1, CXR, "DONE", "2021-03-01T03:00:00Z", 1_000, 400);
        String j2 = job(s2, CXR, "DONE", "2021-03-02T03:00:00Z", 3_000, 600);
        job(s2, CXR, "FAILED", "2021-03-02T04:00:00Z", 500, null);
        String j4 = job(s3, CT, "DONE", "2021-03-02T16:59:00Z", 60_000, 50_000); // 2021-03-02 23:59 local
        job(s3, CT, "QUEUED", "2021-03-02T17:00:00Z", null, null);                // 2021-03-03 00:00 local
        String j6 = job(s4, CXR, "DONE", "2021-03-03T05:00:00Z", 2_000, 100);   // deleted case
        job(s0, CXR, "DONE", "2021-02-27T01:00:00Z", 9_000, 9_000);              // before the range

        aiFinding(j1, s1, "Effusion", "ACCEPTED", null, "2021-03-01T05:00:00Z");
        aiFinding(j1, s1, "Cardiomegaly", "EDITED", "Enlarged heart", "2021-03-01T05:00:00Z");
        aiFinding(j2, s2, "Effusion", "ACCEPTED", null, "2021-03-02T05:00:00Z");
        aiFinding(j2, s2, "Nodule", "REJECTED", null, "2021-03-02T05:00:00Z");
        aiFinding(j2, s2, "Mass", "ACCEPTED", null, "2021-02-20T05:00:00Z");       // reviewed before the range
        aiFinding(j4, s3, "liver", "PENDING", null, null);
        aiFinding(j6, s4, "Effusion", "ACCEPTED", null, "2021-03-03T06:00:00Z");   // deleted case
        jdbc.update("""
                insert into finding (id, study_id, series_id, source, label, review_status, reviewed_by, reviewed_at)
                values (gen_random_uuid(), ?::uuid, ?::uuid, 'MANUAL', 'Fracture', 'ACCEPTED', gen_random_uuid(),
                        '2021-03-01T06:00:00Z')
                """, s1[0], s1[1]);

        report(s1, "FINAL", "2021-03-01T07:00:00Z");
        report(s2, "DRAFT", "2021-03-02T07:00:00Z");
        report(s4, "DRAFT", "2021-03-03T07:00:00Z"); // deleted case
    }

    private String patient(String createdAt, boolean deleted) {
        String id = UUID.randomUUID().toString();
        jdbc.update("insert into patient (id, code, created_at, deleted_at) values (?::uuid, ?, ?::timestamptz, "
                + (deleted ? "?::timestamptz + interval '1 hour'" : "null") + ")",
                deleted ? new Object[] {id, "DASH-" + id.substring(0, 8), createdAt, createdAt}
                        : new Object[] {id, "DASH-" + id.substring(0, 8), createdAt});
        return id;
    }

    /** Returns {studyId, seriesId}. */
    private String[] study(String patientId, String inputType, String createdAt) {
        String study = UUID.randomUUID().toString();
        String series = UUID.randomUUID().toString();
        jdbc.update("insert into study (id, patient_id, input_type, created_at) values (?::uuid, ?::uuid, ?, ?::timestamptz)",
                study, patientId, inputType, createdAt);
        jdbc.update("insert into series (id, study_id) values (?::uuid, ?::uuid)", series, study);
        return new String[] {study, series};
    }

    private String job(String[] study, String model, String status, String queuedAt, Integer durationMs, Integer inferenceMs) {
        String id = UUID.randomUUID().toString();
        jdbc.update("""
                insert into prediction_job (id, study_id, series_id, model_id, status, queued_at, finished_at)
                values (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?::timestamptz,
                        ?::timestamptz + cast(? as integer) * interval '1 millisecond')
                """, id, study[0], study[1], model, status, queuedAt, durationMs == null ? null : queuedAt, durationMs);
        if ("DONE".equals(status)) {
            jdbc.update("insert into prediction_result (id, job_id, inference_ms) values (gen_random_uuid(), ?::uuid, ?)",
                    id, inferenceMs);
        }
        return id;
    }

    private void aiFinding(String jobId, String[] study, String label, String status, String reviewLabel, String reviewedAt) {
        String result = jdbc.queryForObject("select id::text from prediction_result where job_id = ?::uuid", String.class, jobId);
        jdbc.update("""
                insert into finding (id, result_id, study_id, series_id, source, label, confidence, review_status,
                                     review_label, reviewed_by, reviewed_at)
                values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, 'AI', ?, 0.9, ?, ?,
                        case when ?::timestamptz is null then null else gen_random_uuid() end, ?::timestamptz)
                """, result, study[0], study[1], label, status, reviewLabel, reviewedAt, reviewedAt);
    }

    private void report(String[] study, String status, String createdAt) {
        boolean signed = "FINAL".equals(status);
        jdbc.update("""
                insert into report (id, study_id, version, status, template, language, author_id, signed_by, signed_at,
                                    pdf_key, created_at, updated_at)
                values (gen_random_uuid(), ?::uuid, 1, ?, 'CXR', 'en', gen_random_uuid(), ?::uuid, ?::timestamptz, ?,
                        ?::timestamptz, ?::timestamptz)
                """, study[0], status, signed ? UUID.randomUUID().toString() : null, signed ? createdAt : null,
                signed ? "reports/x.pdf" : null, createdAt, createdAt);
    }

    private static List<String> texts(JsonNode array, String field) {
        List<String> out = new ArrayList<>();
        array.forEach(n -> out.add(n.get(field).asString()));
        return out;
    }

    @Test
    void figuresOfTheSeededWeek() {
        Response r = get("/dashboard?from=2021-03-01&to=2021-03-07", login("researcher"));
        assertThat(r.status()).isEqualTo(200);
        JsonNode d = r.body();
        assertThat(d.get("from").asString()).isEqualTo("2021-03-01");
        assertThat(d.get("to").asString()).isEqualTo("2021-03-07");
        assertThat(d.get("zone").asString()).isEqualTo("Asia/Ho_Chi_Minh");

        JsonNode totals = d.get("totals");
        assertThat(totals.get("cases").asLong()).isEqualTo(3);
        assertThat(totals.get("studies").asLong()).isEqualTo(3);
        assertThat(totals.get("studiesByInputType").toString()).isEqualTo("{\"IMAGE_2D\":2,\"NIFTI\":1}");
        assertThat(totals.get("jobs").asLong()).isEqualTo(5);
        assertThat(totals.get("jobsByStatus").toString()).isEqualTo("{\"DONE\":3,\"FAILED\":1,\"QUEUED\":1}");
        assertThat(totals.get("reports").toString()).isEqualTo("{\"draft\":1,\"final\":1}");

        JsonNode perModel = d.get("processing").get("perModel");
        assertThat(perModel.toString()).isEqualTo("""
                [{"modelCode":"ct-totalseg","jobs":1,"avgMs":60000,"p50Ms":60000,"p95Ms":60000,"avgInferenceMs":50000},\
                {"modelCode":"cxr-multilabel","jobs":2,"avgMs":2000,"p50Ms":2000,"p95Ms":2900,"avgInferenceMs":500}]""");

        assertThat(d.get("review").toString())
                .isEqualTo("{\"reviewed\":4,\"accepted\":2,\"edited\":1,\"rejected\":1,\"acceptanceRate\":0.75}");
        assertThat(d.get("labels").toString())
                .isEqualTo("[{\"label\":\"Effusion\",\"accepted\":2},{\"label\":\"Enlarged heart\",\"accepted\":1}]");

        JsonNode daily = d.get("daily");
        assertThat(texts(daily, "date")).containsExactly("2021-03-01", "2021-03-02", "2021-03-03", "2021-03-04",
                "2021-03-05", "2021-03-06", "2021-03-07");
        assertThat(daily.get(0).toString()).isEqualTo("{\"date\":\"2021-03-01\",\"cases\":2,\"jobs\":1,\"failedJobs\":0}");
        assertThat(daily.get(1).toString()).isEqualTo("{\"date\":\"2021-03-02\",\"cases\":1,\"jobs\":3,\"failedJobs\":1}");
        assertThat(daily.get(2).toString()).isEqualTo("{\"date\":\"2021-03-03\",\"cases\":0,\"jobs\":1,\"failedJobs\":0}");
        for (int i = 3; i < 7; i++) {
            assertThat(daily.get(i).get("cases").asLong() + daily.get(i).get("jobs").asLong()).isZero();
        }

        JsonNode recent = d.get("recentJobs");
        assertThat(recent.size()).isEqualTo(5);
        assertThat(texts(recent, "status")).containsExactly("QUEUED", "DONE", "FAILED", "DONE", "DONE");
        assertThat(texts(recent, "modelCode")).containsExactly("ct-totalseg", "ct-totalseg", "cxr-multilabel",
                "cxr-multilabel", "cxr-multilabel");
        assertThat(recent.get(0).get("finishedAt").isNull()).isTrue();
        assertThat(recent.get(1).get("queuedAt").asString()).isEqualTo("2021-03-02T16:59:00Z");

        // nothing that identifies a case
        assertThat(r.body().toString()).doesNotContain("DASH-").doesNotContain("patient");
    }

    @Test
    void aDayEndsAtLocalMidnight() {
        JsonNode d = get("/dashboard?from=2021-03-02&to=2021-03-02", login("doctor")).body();
        assertThat(d.get("totals").get("cases").asLong()).isEqualTo(1);  // P3 at 00:00 local, not P2 at 23:59:59 the day before
        assertThat(d.get("totals").get("jobs").asLong()).isEqualTo(3);   // the job at 23:59 local counts, the one at 00:00 not
        assertThat(d.get("daily").size()).isEqualTo(1);
        assertThat(d.get("processing").get("perModel").size()).isEqualTo(2);

        JsonNode first = get("/dashboard?from=2021-03-01&to=2021-03-01", login("tech")).body();
        assertThat(first.get("totals").get("cases").asLong()).isEqualTo(2); // P1 at 00:00 local, P2 at 23:59:59
    }

    @Test
    void anEmptyRangeHasZerosAndNoRate() {
        JsonNode d = get("/dashboard?from=2019-01-01&to=2019-01-03", login("admin")).body();
        assertThat(d.get("totals").get("cases").asLong()).isZero();
        assertThat(d.get("totals").get("studiesByInputType").size()).isZero();
        assertThat(d.get("review").get("acceptanceRate").isNull()).isTrue();
        assertThat(d.get("labels").size()).isZero();
        assertThat(d.get("recentJobs").size()).isZero();
        assertThat(d.get("daily").size()).isEqualTo(3);
    }

    @Test
    void everyRoleSeesTheDashboardOfTheLastThirtyDaysByDefault() {
        for (String user : List.of("admin", "doctor", "tech", "researcher")) {
            Response r = get("/dashboard", login(user));
            assertThat(r.status()).isEqualTo(200);
            assertThat(r.body().get("daily").size()).isEqualTo(30);
        }
        assertThat(get("/dashboard", null).status()).isEqualTo(401);
    }

    @Test
    void invalidRangesAreRefused() {
        String doctor = login("doctor");
        Response reversed = get("/dashboard?from=2021-03-02&to=2021-03-01", doctor);
        assertThat(reversed.status()).isEqualTo(400);
        assertThat(reversed.body().get("type").asString()).isEqualTo("/problems/invalid-date-range");
        assertThat(get("/dashboard?from=2020-01-01&to=2020-12-31", doctor).status()).isEqualTo(200); // 366 days (leap year)
        assertThat(get("/dashboard?from=2020-01-01&to=2021-01-01", doctor).status()).isEqualTo(400); // 367
        assertThat(get("/dashboard?from=01-03-2021", doctor).status()).isEqualTo(400);
        assertThat(get("/dashboard?from=2021-02-30", doctor).status()).isEqualTo(400);
    }
}
