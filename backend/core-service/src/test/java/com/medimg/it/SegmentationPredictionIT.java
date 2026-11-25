package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/** 3D segmentation ({@code ct-totalseg}) on a volume study, with a simulated ai-worker. */
class SegmentationPredictionIT extends IntegrationTest {

    private static String[] volumeStudy;
    private static String[] imageStudy;

    @Autowired
    JdbcTemplate jdbc;

    private String doctor;

    @BeforeEach
    void setUp() throws Exception {
        doctor = login("doctor");
        if (volumeStudy == null) {
            volumeStudy = uploadVolumeStudy(doctor, createCase(doctor));
            imageStudy = uploadStudy(doctor, createCase(doctor));
        }
    }

    @Test
    void segmentationOfAVolumeStudyReturnsTheLabelmapMeshesAndVolumes() {
        Response created = post("/predictions", doctor, Map.of("studyId", volumeStudy[0], "seriesId", volumeStudy[1],
                "modelCode", "ct-totalseg"));
        assertThat(created.status()).isEqualTo(202);
        String jobId = created.body().get("jobId").asString();

        Map<String, String> msg = awaitJobMessage(jobId, 1);
        assertThat(msg).containsEntry("modelCode", "ct-totalseg").containsEntry("modelVersion", "2.18.0-fast")
                .containsEntry("task", "SEGMENTATION_3D").containsEntry("inputType", "NIFTI")
                .containsEntry("inputUri", "s3://medimg/studies/" + volumeStudy[0] + "/series/" + volumeStudy[1] + "/volume.nii.gz")
                .containsEntry("outputPrefix", "s3://medimg/predictions/" + jobId + "/1/")
                .containsEntry("params", "{}");

        String out = "s3://medimg/predictions/" + jobId + "/1/";
        String payload = """
                {"modelVersion":"2.18.0-fast","inferenceMs":61000,
                 "findings":[{"label":"spleen","confidence":null,"volumeMl":212.456,"bbox":null},
                             {"label":"liver","confidence":null,"volumeMl":1530.2,"bbox":null}],
                 "artifacts":{"heatmaps":{},"segmentation":"%ssegmentation.nii.gz",
                   "meshes":[{"label":"liver","color":"#DC6E50","uri":"%smeshes/liver.glb","triangles":49870,
                              "volumeMl":1530.2,"centroid":[-60.5,25.0,-410.75]},
                             {"label":"spleen","color":"#9DBCDD","uri":"%smeshes/spleen.glb","triangles":12001,
                              "volumeMl":212.456,"centroid":[95.0,40.25,-395.0]}]}}
                """.formatted(out, out, out);
        workerResult(jobId, 1, "STARTED", Map.of());
        workerResult(jobId, 1, "DONE", Map.of("payload", payload));
        await().atMost(Duration.ofSeconds(10)).until(() -> "DONE".equals(get("/predictions/" + jobId, doctor).body().get("status").asString()));

        JsonNode done = get("/predictions/" + jobId, doctor).body();
        JsonNode findings = done.get("findings");
        assertThat(findings.size()).isEqualTo(2);
        assertThat(findings.get(0).get("label").asString()).isEqualTo("liver"); // largest first
        assertThat(findings.get(0).get("confidence").isNull()).isTrue();
        assertThat(findings.get(0).get("volumeMl").decimalValue()).isEqualByComparingTo("1530.20");
        assertThat(findings.get(1).get("volumeMl").decimalValue()).isEqualByComparingTo("212.46");
        JsonNode artifacts = done.get("artifacts");
        assertThat(artifacts.get("heatmaps").size()).isZero();
        assertThat(artifacts.get("segmentation").asString()).contains("/predictions/" + jobId + "/1/segmentation.nii.gz");
        JsonNode liver = artifacts.get("meshes").get(0);
        assertThat(artifacts.get("meshes").size()).isEqualTo(2);
        assertThat(liver.get("label").asString()).isEqualTo("liver");
        assertThat(liver.get("color").asString()).isEqualTo("#DC6E50");
        assertThat(liver.get("url").asString()).contains("/predictions/" + jobId + "/1/meshes/liver.glb").contains("X-Amz-Signature");
        assertThat(liver.get("triangles").asInt()).isEqualTo(49870);
        assertThat(liver.get("volumeMl").asDouble()).isEqualTo(1530.2);
        assertThat(liver.get("centroid").toString()).isEqualTo("[-60.5,25.0,-410.75]");
        assertThat(jdbc.queryForObject("select segmentation_key from prediction_result where job_id = ?::uuid", String.class, jobId))
                .isEqualTo("predictions/" + jobId + "/1/segmentation.nii.gz");
    }

    @Test
    void modelsAreOfferedAndAcceptedOnlyForTheirInputTypeAndModality() {
        List<String> volumeModels = codes(get("/models?inputType=NIFTI", doctor).body());
        assertThat(volumeModels).containsExactly("ct-totalseg");
        assertThat(codes(get("/models?inputType=DICOM_SERIES", doctor).body())).containsExactly("ct-totalseg");
        assertThat(codes(get("/models?inputType=IMAGE_2D", doctor).body())).containsExactly("cxr-multilabel");
        JsonNode labels = get("/models?inputType=NIFTI", doctor).body().get(0).get("labels");
        assertThat(labels.size()).isEqualTo(21);
        assertThat(labels.get(0).asString()).isEqualTo("liver");
        assertThat(labels.get(20).asString()).isEqualTo("adrenal_glands");

        Response chestModelOnVolume = post("/predictions", doctor, Map.of("studyId", volumeStudy[0],
                "seriesId", volumeStudy[1], "modelCode", "cxr-multilabel"));
        assertThat(chestModelOnVolume.status()).isEqualTo(422);
        assertThat(chestModelOnVolume.body().get("detail").asString()).contains("does not accept NIFTI");

        Response ctModelOn2d = post("/predictions", doctor, Map.of("studyId", imageStudy[0], "seriesId", imageStudy[1],
                "modelCode", "ct-totalseg"));
        assertThat(ctModelOn2d.status()).isEqualTo(422);
        assertThat(ctModelOn2d.body().get("detail").asString()).contains("does not accept IMAGE_2D");

        // a volume study whose modality is not CT
        jdbc.update("update series set modality = 'MR' where id = ?::uuid", volumeStudy[1]);
        try {
            Response mr = post("/predictions", doctor, Map.of("studyId", volumeStudy[0], "seriesId", volumeStudy[1],
                    "modelCode", "ct-totalseg"));
            assertThat(mr.status()).isEqualTo(422);
            assertThat(mr.body().get("detail").asString()).contains("is for CT").contains("MR");
        } finally {
            jdbc.update("update series set modality = 'CT' where id = ?::uuid", volumeStudy[1]);
        }
    }

    @Test
    void researcherCanViewVolumeStudiesButNotUploadOrSegmentThem() throws Exception {
        String researcher = login("researcher");

        JsonNode series = get("/studies/" + volumeStudy[0], researcher).body().get("series").get(0);
        assertThat(series.get("volumeUrl").asString()).isNotBlank();
        assertThat(series.get("dims").size()).isEqualTo(3);
        assertThat(get("/models?inputType=NIFTI", researcher).status()).isEqualTo(200);

        assertThat(post("/predictions", researcher, Map.of("studyId", volumeStudy[0], "seriesId", volumeStudy[1],
                "modelCode", "ct-totalseg")).status()).isEqualTo(403);
        assertThat(post("/uploads/init", researcher, Map.of("patientId", createCase(doctor), "files",
                List.of(Map.of("name", "ct.nii.gz", "size", 1000, "contentType", "application/gzip")))).status())
                .isEqualTo(403);
    }

    private static List<String> codes(JsonNode models) {
        return models.valueStream().map(m -> m.get("code").asString()).toList();
    }
}
