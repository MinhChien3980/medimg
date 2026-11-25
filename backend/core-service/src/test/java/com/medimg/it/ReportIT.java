package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/**
 * Reports: a doctor writes a draft pre-filled from the reviewed findings, adds key images, signs it into an immutable
 * PDF and amends it with a new version. Drafts are hidden from researchers.
 */
class ReportIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void doctorWritesSignsAndAmendsAVietnameseChestXrayReport() throws Exception {
        String doctor = login("doctor");
        JsonNode patient = post("/patients", doctor, Map.of("birthYear", 1968, "sex", "F")).body();
        String[] study = uploadStudy(doctor, patient.get("id").asString());
        completedPrediction(doctor, study, "cxr-multilabel",
                "[{\"label\":\"Effusion\",\"confidence\":0.81},{\"label\":\"Mass\",\"confidence\":0.4}]");
        for (JsonNode f : get("/studies/" + study[0] + "/findings", doctor).body()) {
            String status = "Effusion".equals(f.get("label").asString()) ? "ACCEPTED" : "REJECTED";
            call("PATCH", "/findings/" + f.get("id").asString() + "/review", doctor,
                    Map.of("status", status, "note", "phải", "version", 0), Map.of());
        }
        String manualId = post("/studies/" + study[0] + "/findings", doctor,
                Map.of("seriesId", study[1], "label", "Gãy xương sườn")).body().get("id").asString();
        post("/studies/" + study[0] + "/annotations", doctor, Map.of("seriesId", study[1], "kind", "RECTANGLE",
                "label", "Nốt mờ thuỳ trên", "geometry", Map.of("x", 10, "y", 10, "width", 20, "height", 10),
                "measurement", Map.of("areaPx2", 200)));

        // 1. a draft pre-filled from the study
        Response created = post("/studies/" + study[0] + "/reports", doctor, Map.of("language", "vi"));
        assertThat(created.status()).isEqualTo(201);
        JsonNode v1 = created.body();
        String v1Path = "/reports/" + v1.get("id").asString();
        assertThat(v1.get("version").asInt()).isEqualTo(1);
        assertThat(v1.get("status").asString()).isEqualTo("DRAFT");
        assertThat(v1.get("template").asString()).isEqualTo("CXR");
        assertThat(v1.get("language").asString()).isEqualTo("vi");
        assertThat(v1.get("author").get("fullName").asString()).isEqualTo("Demo Doctor");
        assertThat(v1.get("technique").asString()).contains("X-quang ngực").contains("300 × 300 px")
                .contains("cxr-multilabel 0.1.0-xrv");
        assertThat(v1.get("findingsText").asString())
                .contains("- Effusion (AI, độ tin cậy 81%): phải")
                .contains("- Gãy xương sườn (bác sĩ thêm)")
                .contains("- Nốt mờ thuỳ trên (hình chữ nhật, diện tích 200 px²)")
                .doesNotContain("Mass");
        assertThat(post("/studies/" + study[0] + "/reports", doctor, Map.of("language", "vi")).status()).isEqualTo(409);
        assertThat(post("/studies/" + study[0] + "/reports", doctor, Map.of("language", "fr")).status()).isEqualTo(400);

        // 2. drafts: read by clinicians and ADMIN, hidden from RESEARCHER, written by doctors only
        String tech = login("tech");
        String researcher = login("researcher");
        assertThat(get(v1Path, tech).status()).isEqualTo(200);
        assertThat(get(v1Path, login("admin")).status()).isEqualTo(200);
        assertThat(get(v1Path, researcher).status()).isEqualTo(403);
        assertThat(get("/studies/" + study[0] + "/reports", researcher).body().size()).isZero();
        assertThat(get(v1Path + "/preview.pdf", researcher).status()).isEqualTo(403);
        assertThat(call("PUT", v1Path, tech, Map.of("impression", "x", "rowVersion", 0), Map.of()).status()).isEqualTo(403);

        // 3. key images: presigned PUT of a PNG, checked at complete
        JsonNode upload = initKeyImage(v1Path, doctor, png(64, 48), "Phim thẳng");
        assertThat(putObject(upload.get("putUrl").asString(), png(64, 48)).statusCode()).isEqualTo(200);
        Response completed = post(v1Path + "/key-images/" + upload.get("imageId").asString() + "/complete", doctor, null);
        assertThat(completed.status()).isEqualTo(200);
        assertThat(completed.body().get("uploaded").asBoolean()).isTrue();
        assertThat(completed.body().get("url").asString()).contains("/key-images/");

        byte[] notPng = "not an image".getBytes(StandardCharsets.UTF_8);
        JsonNode fake = initKeyImage(v1Path, doctor, notPng, null);
        putObject(fake.get("putUrl").asString(), notPng);
        assertThat(post(v1Path + "/key-images/" + fake.get("imageId").asString() + "/complete", doctor, null).status())
                .isEqualTo(422);
        JsonNode missing = initKeyImage(v1Path, doctor, png(8, 8), null);
        String missingPath = v1Path + "/key-images/" + missing.get("imageId").asString();
        assertThat(post(missingPath + "/complete", doctor, null).status()).isEqualTo(409);
        assertThat(call("DELETE", missingPath, doctor, null, Map.of()).status()).isEqualTo(204);
        assertThat(post(v1Path + "/key-images/init", doctor, Map.of("contentType", "image/jpeg", "size", 100)).status())
                .isEqualTo(400);
        assertThat(post(v1Path + "/key-images/init", doctor, Map.of("contentType", "image/png", "size", 6 * 1024 * 1024))
                .status()).isEqualTo(400);
        JsonNode draft = get(v1Path, doctor).body();
        assertThat(draft.get("keyImages").size()).isEqualTo(1); // the rejected and the deleted ones are gone
        assertThat(draft.get("keyImages").get(0).get("caption").asString()).isEqualTo("Phim thẳng");

        // 4. preview, edit with optimistic locking, sign
        HttpResponse<byte[]> preview = download(v1Path + "/preview.pdf", tech);
        assertThat(preview.statusCode()).isEqualTo(200);
        assertThat(preview.headers().firstValue("Content-Type")).hasValue("application/pdf");
        assertThat(text(preview.body())).contains("BẢN NHÁP");

        long rowVersion = draft.get("rowVersion").asLong();
        assertThat(post(v1Path + "/finalize", doctor, Map.of("rowVersion", rowVersion)).status()).isEqualTo(422); // no impression
        Response edited = call("PUT", v1Path, doctor, Map.of("clinicalInfo", "Ho kéo dài 3 tuần",
                "technique", draft.get("technique").asString(), "findingsText", draft.get("findingsText").asString(),
                "impression", "Tràn dịch màng phổi phải lượng ít.", "rowVersion", rowVersion), Map.of());
        assertThat(edited.status()).isEqualTo(200);
        assertThat(edited.body().get("rowVersion").asLong()).isGreaterThan(rowVersion);
        assertThat(call("PUT", v1Path, doctor, Map.of("impression", "stale", "rowVersion", rowVersion), Map.of()).status())
                .isEqualTo(409);
        assertThat(post(v1Path + "/finalize", doctor, Map.of("rowVersion", rowVersion)).status()).isEqualTo(409);

        Response signed = post(v1Path + "/finalize", doctor, Map.of("rowVersion", edited.body().get("rowVersion").asLong()));
        assertThat(signed.status()).isEqualTo(200);
        assertThat(signed.body().get("status").asString()).isEqualTo("FINAL");
        assertThat(signed.body().get("signedBy").get("fullName").asString()).isEqualTo("Demo Doctor");
        assertThat(signed.body().get("signedAt").isNull()).isFalse();

        // 5. the signed PDF, for every reader
        String pdfText = text(downloadPdf(v1Path, researcher));
        assertThat(pdfText)
                .contains("Bản demo nghiên cứu – không dùng cho chẩn đoán")
                .contains("Báo cáo X-quang ngực")
                .contains(patient.get("code").asString())
                .contains("1968")
                .contains("Tràn dịch màng phổi phải lượng ít.")
                .contains("Gãy xương sườn")
                .contains("Phim thẳng")
                .contains("(giờ Việt Nam)")
                .doesNotContain("BẢN NHÁP");
        assertThat(get(v1Path, researcher).status()).isEqualTo(200);
        assertThat(get("/studies/" + study[0] + "/reports", researcher).body().size()).isEqualTo(1);

        // 6. a final report never changes, nor do the findings it cites
        assertThat(call("PUT", v1Path, doctor, Map.of("impression", "x",
                "rowVersion", signed.body().get("rowVersion").asLong()), Map.of()).status()).isEqualTo(409);
        assertThat(call("DELETE", v1Path, doctor, null, Map.of()).status()).isEqualTo(409);
        assertThat(post(v1Path + "/key-images/init", doctor, Map.of("contentType", "image/png", "size", 100)).status())
                .isEqualTo(409);
        assertThat(get(v1Path + "/preview.pdf", doctor).status()).isEqualTo(409);
        assertThat(call("DELETE", "/findings/" + manualId, doctor, null, Map.of()).status()).isEqualTo(409);
        assertThatThrownBy(() -> jdbc.update("update report set impression = 'tampered' where id = ?::uuid",
                v1.get("id").asString())).rootCause().hasMessageContaining("is final");

        // 7. amendment: version 2 starts from version 1 and names it in its PDF
        Response amended = post(v1Path + "/amend", doctor, null);
        assertThat(amended.status()).isEqualTo(201);
        JsonNode v2 = amended.body();
        String v2Path = "/reports/" + v2.get("id").asString();
        assertThat(v2.get("version").asInt()).isEqualTo(2);
        assertThat(v2.get("status").asString()).isEqualTo("DRAFT");
        assertThat(v2.get("amendsReportId").asString()).isEqualTo(v1.get("id").asString());
        assertThat(v2.get("impression").asString()).isEqualTo("Tràn dịch màng phổi phải lượng ít.");
        JsonNode copiedImage = v2.get("keyImages").get(0);
        assertThat(copiedImage.get("uploaded").asBoolean()).isTrue();
        assertThat(copiedImage.get("id").asString()).isNotEqualTo(draft.get("keyImages").get(0).get("id").asString());
        assertThat(post(v1Path + "/amend", doctor, null).status()).isEqualTo(409); // a draft exists
        assertThat(post("/studies/" + study[0] + "/reports", doctor, Map.of("language", "vi")).status()).isEqualTo(409);
        assertThat(call("DELETE", v2Path, tech, null, Map.of()).status()).isEqualTo(403);

        Response v2Edited = call("PUT", v2Path, doctor, Map.of("impression", "Tràn dịch màng phổi phải, đã dẫn lưu.",
                "rowVersion", v2.get("rowVersion").asLong()), Map.of());
        assertThat(post(v2Path + "/finalize", doctor, Map.of("rowVersion", v2Edited.body().get("rowVersion").asLong()))
                .status()).isEqualTo(200);
        assertThat(text(downloadPdf(v2Path, doctor))).contains("Bổ sung cho báo cáo v1 ngày").contains("đã dẫn lưu");
        assertThat(get(v1Path, doctor).body().get("impression").asString()).isEqualTo("Tràn dịch màng phổi phải lượng ít.");
        assertThat(post(v1Path + "/amend", doctor, null).status()).isEqualTo(409); // only the latest version

        JsonNode history = get("/studies/" + study[0] + "/reports", researcher).body();
        assertThat(history.size()).isEqualTo(2);
        assertThat(history.get(0).get("version").asInt()).isEqualTo(2);
        assertThat(history.get(1).get("version").asInt()).isEqualTo(1);

        String reportId = v1.get("id").asString();
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject("""
                select count(distinct action) from audit_log where resource_id = ? and outcome = 'SUCCESS'
                  and action in ('REPORT_CREATED', 'REPORT_UPDATED', 'REPORT_FINALIZED', 'REPORT_AMENDED',
                                 'REPORT_PDF_DOWNLOADED')
                """, Long.class, reportId) == 5);
    }

    @Test
    void ctReportDefaultsToTheCtTemplateWithOrganVolumesAndTheAuthorDeletesItsDraft() throws Exception {
        String doctor = login("doctor");
        String[] ct = uploadVolumeStudy(doctor, createCase(doctor));
        completedPrediction(doctor, ct, "ct-totalseg", """
                [{"label":"liver","confidence":null,"volumeMl":1530.24},{"label":"spleen","volumeMl":212.5}]""");
        JsonNode liver = get("/studies/" + ct[0] + "/findings", doctor).body().get(0);
        call("PATCH", "/findings/" + liver.get("id").asString() + "/review", doctor,
                Map.of("status", "ACCEPTED", "version", 0), Map.of());

        Response created = post("/studies/" + ct[0] + "/reports", doctor, Map.of("language", "en"));
        assertThat(created.status()).isEqualTo(201);
        JsonNode report = created.body();
        assertThat(report.get("template").asString()).isEqualTo("CT");
        assertThat(report.get("technique").asString())
                .contains("Computed tomography, modality CT; volume 512 × 512 × 301 voxels, voxel spacing 0.78 × 0.78 × 1.5 mm")
                .contains("ct-totalseg 2.18.0-fast");
        assertThat(report.get("findingsText").asString()).isEqualTo("- Liver (AI, volume 1,530.2 ml)");

        String path = "/reports/" + report.get("id").asString();
        assertThat(download(path + "/preview.pdf", doctor).statusCode()).isEqualTo(200);
        assertThat(get(path + "/pdf", doctor).status()).isEqualTo(409); // a draft has no signed PDF
        assertThat(call("DELETE", path, doctor, null, Map.of()).status()).isEqualTo(204);
        assertThat(get(path, doctor).status()).isEqualTo(404);
        assertThat(get("/studies/" + UUID.randomUUID() + "/reports", doctor).status()).isEqualTo(404);
    }

    @Test
    void vietnameseCtDraftNamesOrgansAndIsRefilledFromReviewsMadeAfterItWasCreated() throws Exception {
        String doctor = login("doctor");
        String[] ct = uploadVolumeStudy(doctor, createCase(doctor));
        completedPrediction(doctor, ct, "ct-totalseg", """
                [{"label":"liver","volumeMl":1530.24},{"label":"hip","volumeMl":410.0},{"label":"spine","volumeMl":380.5}]""");
        Map<String, JsonNode> organs = new HashMap<>();
        get("/studies/" + ct[0] + "/findings", doctor).body().forEach(f -> organs.put(f.get("label").asString(), f));
        review(doctor, organs.get("liver"), Map.of("status", "ACCEPTED", "version", 0));

        // 1. organs named in the report's language; the findings reviewed so far
        JsonNode draft = post("/studies/" + ct[0] + "/reports", doctor, Map.of("language", "vi")).body();
        String path = "/reports/" + draft.get("id").asString();
        assertThat(draft.get("findingsText").asString()).isEqualTo("- Gan (AI, thể tích 1.530,2 ml)");
        Response edited = call("PUT", path, doctor, Map.of("clinicalInfo", "Đau hạ sườn phải",
                "technique", "sửa tay", "findingsText", "sửa tay", "impression", "Gan bình thường.",
                "rowVersion", draft.get("rowVersion").asLong()), Map.of());
        long rowVersion = edited.body().get("rowVersion").asLong();

        // 2. reviewed and annotated after the draft was written: not in it until it is refilled
        review(doctor, organs.get("hip"), Map.of("status", "ACCEPTED", "note", "gãy cũ", "version", 0));
        review(doctor, organs.get("spine"), Map.of("status", "EDITED", "label", "Cột sống thắt lưng", "version", 0));
        post("/studies/" + ct[0] + "/annotations", doctor, Map.of("seriesId", ct[1], "kind", "ELLIPSE_ROI",
                "label", "Nang gan", "geometry", Map.of(
                        "points", List.of(List.of(-20.5, 30, -400), List.of(-20.5, 10, -400),
                                List.of(-30.5, 20, -400), List.of(-10.5, 20, -400)),
                        "viewPlaneNormal", List.of(0, 0, 1), "viewUp", List.of(0, -1, 0), "sliceIndex", 120),
                "measurement", Map.of("areaMm2", 314.2, "meanHu", 8.5)));
        assertThat(get(path, doctor).body().get("findingsText").asString()).isEqualTo("sửa tay");

        // 3. refill: a doctor, on the version last read; only technique and findings are rewritten
        assertThat(post(path + "/refill", login("tech"), Map.of("rowVersion", rowVersion)).status()).isEqualTo(403);
        assertThat(post(path + "/refill", doctor, Map.of("rowVersion", rowVersion - 1)).status()).isEqualTo(409);
        assertThat(post(path + "/refill", doctor, Map.of()).status()).isEqualTo(400);
        Response refilled = post(path + "/refill", doctor, Map.of("rowVersion", rowVersion));
        assertThat(refilled.status()).isEqualTo(200);
        JsonNode report = refilled.body();
        assertThat(report.get("findingsText").asString()).isEqualTo("""
                - Gan (AI, thể tích 1.530,2 ml)
                - Xương chậu (AI, thể tích 410 ml): gãy cũ
                - Cột sống thắt lưng (AI, thể tích 380,5 ml)

                Đánh dấu trên ảnh:
                - Nang gan (vùng elip, diện tích 314,2 mm², trung bình 8,5 HU)""");
        assertThat(report.get("technique").asString()).startsWith("Chụp cắt lớp vi tính, phương thức CT")
                .contains("ct-totalseg 2.18.0-fast");
        assertThat(report.get("clinicalInfo").asString()).isEqualTo("Đau hạ sườn phải");
        assertThat(report.get("impression").asString()).isEqualTo("Gan bình thường.");
        assertThat(report.get("rowVersion").asLong()).isGreaterThan(rowVersion);
        assertThat(report.get("updatedAt").asString()).isNotEqualTo(edited.body().get("updatedAt").asString());

        // 4. the signed PDF names the organs in Vietnamese, in the findings text and in the table
        Response signed = post(path + "/finalize", doctor, Map.of("rowVersion", report.get("rowVersion").asLong()));
        assertThat(signed.status()).isEqualTo(200);
        String pdfText = text(downloadPdf(path, doctor));
        assertThat(pdfText)
                .contains("Báo cáo chụp cắt lớp vi tính (CT)")
                .contains("- Gan (AI, thể tích 1.530,2 ml)")
                .contains("- Xương chậu (AI, thể tích 410 ml): gãy cũ")
                .contains("Cột sống thắt lưng")
                .contains("Nang gan")
                .doesNotContain("Không có phát hiện nào được chấp nhận")
                .doesNotContain("liver") // nor in the table of reviewed findings
                .doesNotContainPattern("\\bhip\\b")
                .doesNotContainPattern("\\bspine\\b");

        // 5. a final report is not refilled, even on its current version
        assertThat(post(path + "/refill", doctor, Map.of("rowVersion", signed.body().get("rowVersion").asLong()))
                .status()).isEqualTo(409);
        assertThat(get(path, doctor).body().get("findingsText").asString()).isEqualTo(report.get("findingsText").asString());
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject("""
                select count(*) from audit_log where resource_id = ? and action = 'REPORT_REFILLED'
                  and outcome = 'SUCCESS'
                """, Long.class, draft.get("id").asString()) == 1);
    }

    private void review(String token, JsonNode finding, Map<String, Object> body) {
        assertThat(call("PATCH", "/findings/" + finding.get("id").asString() + "/review", token, body, Map.of())
                .status()).isEqualTo(200);
    }

    private JsonNode initKeyImage(String reportPath, String token, byte[] content, String caption) {
        Map<String, Object> body = caption == null ? Map.of("contentType", "image/png", "size", content.length)
                : Map.of("contentType", "image/png", "size", content.length, "caption", caption);
        Response init = post(reportPath + "/key-images/init", token, body);
        assertThat(init.status()).isEqualTo(201);
        return init.body();
    }

    /** The signed PDF, through the presigned link. */
    private byte[] downloadPdf(String reportPath, String token) throws IOException, InterruptedException {
        Response link = get(reportPath + "/pdf", token);
        assertThat(link.status()).isEqualTo(200);
        HttpResponse<byte[]> pdf = raw.send(HttpRequest.newBuilder(URI.create(link.body().get("url").asString())).build(),
                HttpResponse.BodyHandlers.ofByteArray());
        assertThat(pdf.statusCode()).isEqualTo(200);
        assertThat(new String(pdf.body(), 0, 4, StandardCharsets.US_ASCII)).isEqualTo("%PDF");
        return pdf.body();
    }

    private HttpResponse<byte[]> download(String path, String token) throws IOException, InterruptedException {
        return raw.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1" + path))
                .header("Authorization", "Bearer " + token).build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private static String text(byte[] pdf) throws IOException {
        try (PDDocument doc = Loader.loadPDF(pdf)) {
            PDFTextStripper stripper = new PDFTextStripper();
            stripper.setSortByPosition(true);
            return stripper.getText(doc);
        }
    }
}
