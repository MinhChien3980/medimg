package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/**
 * Annotations: image pixels on 2D images (checked against the image size), patient millimetres on volumes (checked
 * against their view plane); doctors and technicians draw them and only the author changes them.
 */
class AnnotationIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void technicianDrawsOnAnUncalibratedImageInPixelsAndOnlyTheAuthorChangesIt() throws Exception {
        String doctor = login("doctor");
        String tech = login("tech");
        String[] study = uploadStudy(doctor, createCase(doctor)); // 300 x 300 px PNG
        String path = "/studies/" + study[0] + "/annotations";

        Response created = post(path, tech, Map.of("seriesId", study[1], "kind", "RECTANGLE", "label", " Opacity ",
                "geometry", Map.of("x", 10, "y", 20, "width", 50, "height", 40),
                "measurement", Map.of("areaPx2", 2000)));
        assertThat(created.status()).isEqualTo(201);
        JsonNode rectangle = created.body();
        assertThat(rectangle.get("kind").asString()).isEqualTo("RECTANGLE");
        assertThat(rectangle.get("label").asString()).isEqualTo("Opacity");
        assertThat(rectangle.get("geometry").get("width").asDouble()).isEqualTo(50);
        assertThat(rectangle.get("measurement").get("areaPx2").asDouble()).isEqualTo(2000);
        assertThat(rectangle.get("measurement").has("lengthMm")).isFalse();
        assertThat(rectangle.get("author").get("fullName").asString()).isEqualTo("Demo Technician");
        assertThat(rectangle.get("version").asLong()).isZero();

        assertBadRequest(post(path, tech, Map.of("seriesId", study[1], "kind", "RECTANGLE",
                "geometry", Map.of("x", 280, "y", 20, "width", 50, "height", 40))), "outside the image (300 x 300 px)");
        assertBadRequest(post(path, tech, Map.of("seriesId", study[1], "kind", "LENGTH",
                "geometry", Map.of("from", List.of(0, 0), "to", List.of(30, 40)), "measurement", Map.of("lengthMm", 5))),
                "lengthMm is not allowed");
        assertBadRequest(post(path, tech, Map.of("seriesId", study[1], "kind", "RECTANGLE",
                "geometry", Map.of("x", 1, "y", 1, "width", 5, "height", 5, "depth", 3))), "geometry is not valid");
        assertBadRequest(post(path, tech, Map.of("seriesId", study[1], "kind", "ELLIPSE_ROI",
                "geometry", Map.of("points", List.of()))), "not drawn on 2D images");
        assertBadRequest(post(path, tech, Map.of("seriesId", study[1], "kind", "CIRCLE", "geometry", Map.of())),
                "Unknown annotation kind");

        Response length = post(path, doctor, Map.of("seriesId", study[1], "kind", "LENGTH",
                "geometry", Map.of("from", List.of(0, 0), "to", List.of(30, 40)), "measurement", Map.of("lengthPx", 50)));
        assertThat(length.status()).isEqualTo(201);

        String researcher = login("researcher");
        Response listed = get(path, researcher);
        assertThat(listed.status()).isEqualTo(200);
        assertThat(listed.body().size()).isEqualTo(2);
        assertThat(post(path, researcher, Map.of("seriesId", study[1], "kind", "ARROW",
                "geometry", Map.of("from", List.of(1, 1), "to", List.of(9, 9)))).status()).isEqualTo(403);
        assertThat(post(path, login("admin"), Map.of("seriesId", study[1], "kind", "ARROW",
                "geometry", Map.of("from", List.of(1, 1), "to", List.of(9, 9)))).status()).isEqualTo(403);

        String rectanglePath = "/annotations/" + rectangle.get("id").asString();
        Map<String, Object> moved = Map.of("geometry", Map.of("x", 12, "y", 20, "width", 50, "height", 40),
                "note", "moved", "version", 0);
        assertThat(call("PUT", rectanglePath, doctor, moved, Map.of()).status()).isEqualTo(403);
        assertThat(call("DELETE", rectanglePath, doctor, null, Map.of()).status()).isEqualTo(403);

        Response updated = call("PUT", rectanglePath, tech, moved, Map.of());
        assertThat(updated.status()).isEqualTo(200);
        assertThat(updated.body().get("version").asLong()).isEqualTo(1);
        assertThat(updated.body().get("note").asString()).isEqualTo("moved");
        assertThat(updated.body().get("label").isNull()).isTrue();
        assertThat(updated.body().get("measurement").isNull()).isTrue();
        assertThat(call("PUT", rectanglePath, tech, moved, Map.of()).status()).isEqualTo(409); // version 0 is stale

        assertThat(call("DELETE", rectanglePath, tech, null, Map.of()).status()).isEqualTo(204);
        assertThat(get(path, doctor).body().size()).isEqualTo(1);
        assertThat(call("DELETE", rectanglePath, tech, null, Map.of()).status()).isEqualTo(404);

        String id = rectangle.get("id").asString();
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject("""
                select count(distinct action) from audit_log where resource_id = ? and outcome = 'SUCCESS'
                  and action in ('ANNOTATION_CREATED', 'ANNOTATION_UPDATED', 'ANNOTATION_DELETED')
                """, Long.class, id) == 3);
    }

    @Test
    void calibratedXrayIsMeasuredInMillimetres() throws Exception {
        String doctor = login("doctor");
        String[] xray = uploadDicomXray(doctor, createCase(doctor), 0.2);
        JsonNode series = get("/studies/" + xray[0], doctor).body().get("series").get(0);
        assertThat(series.get("pixelSpacing").get(0).asDouble()).isEqualTo(0.2);
        String path = "/studies/" + xray[0] + "/annotations";
        Map<String, Object> geometry = Map.of("from", List.of(100, 100), "to", List.of(130, 140)); // 50 px, 10 mm

        assertThat(post(path, doctor, Map.of("seriesId", xray[1], "kind", "LENGTH", "geometry", geometry,
                "measurement", Map.of("lengthMm", 10.02))).status()).isEqualTo(201);
        assertBadRequest(post(path, doctor, Map.of("seriesId", xray[1], "kind", "LENGTH", "geometry", geometry,
                "measurement", Map.of("lengthMm", 50))), "does not match the geometry");
        assertBadRequest(post(path, doctor, Map.of("seriesId", xray[1], "kind", "LENGTH", "geometry", geometry,
                "measurement", Map.of("lengthPx", 50))), "lengthPx is not allowed");
    }

    @Test
    void volumeAnnotationsLieInTheirViewPlaneInPatientMillimetres() throws Exception {
        String doctor = login("doctor");
        String[] ct = uploadVolumeStudy(doctor, createCase(doctor)); // 512 x 512 x 301 voxels
        String path = "/studies/" + ct[0] + "/annotations";
        Map<String, Object> ellipse = Map.of(
                "points", List.of(List.of(-20.5, 30, -400), List.of(-20.5, 10, -400), List.of(-30.5, 20, -400),
                        List.of(-10.5, 20, -400)),
                "viewPlaneNormal", List.of(0, 0, 1), "viewUp", List.of(0, -1, 0), "sliceIndex", 120);

        Response created = post(path, doctor, Map.of("seriesId", ct[1], "kind", "ELLIPSE_ROI", "label", "Liver lesion",
                "geometry", ellipse, "measurement", Map.of("areaMm2", 314.2, "meanHu", -12.5, "stdHu", 8.1)));
        assertThat(created.status()).isEqualTo(201);
        JsonNode geometry = created.body().get("geometry");
        assertThat(geometry.get("points").get(0).get(2).asDouble()).isEqualTo(-400);
        assertThat(geometry.get("viewPlaneNormal").get(2).asDouble()).isEqualTo(1);
        assertThat(geometry.get("sliceIndex").asInt()).isEqualTo(120);
        assertThat(created.body().get("measurement").get("meanHu").asDouble()).isEqualTo(-12.5);

        assertBadRequest(post(path, doctor, Map.of("seriesId", ct[1], "kind", "ELLIPSE_ROI", "geometry",
                Map.of("points", ellipse.get("points"), "viewPlaneNormal", List.of(0, 0, 2), "viewUp", List.of(0, -1, 0)))),
                "unit vector");
        assertBadRequest(post(path, doctor, Map.of("seriesId", ct[1], "kind", "RECTANGLE",
                "geometry", Map.of("x", 1, "y", 1, "width", 5, "height", 5))), "not drawn on volumes");
        assertBadRequest(post(path, doctor, Map.of("seriesId", ct[1], "kind", "LENGTH", "geometry",
                Map.of("points", List.of(List.of(0, 0, -400), List.of(0, 10, -390)), "viewPlaneNormal", List.of(0, 0, 1),
                        "viewUp", List.of(0, -1, 0)))), "not in the view plane");
    }

    private static void assertBadRequest(Response response, String detail) {
        assertThat(response.status()).isEqualTo(400);
        assertThat(response.body().get("detail").asString()).contains(detail);
    }
}
