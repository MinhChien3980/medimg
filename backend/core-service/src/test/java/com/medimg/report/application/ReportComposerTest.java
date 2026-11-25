package com.medimg.report.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import com.medimg.annotation.application.AnnotationDtos.AnnotationDto;
import com.medimg.annotation.application.AnnotationDtos.MeasurementDto;
import com.medimg.identity.application.UserRef;
import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.ImagingDtos.StudyRef;
import com.medimg.prediction.application.PredictionDtos.FindingDto;
import com.medimg.prediction.application.PredictionDtos.ModelRef;
import com.medimg.prediction.application.PredictionDtos.ReviewDto;
import com.medimg.report.domain.ReportLanguage;
import com.medimg.report.domain.ReportTemplate;

class ReportComposerTest {

    private static final Instant SIGNED = Instant.parse("2026-11-25T23:30:00Z");
    private static final UserRef DOCTOR = new UserRef(UUID.randomUUID(), "Demo Doctor");

    private final ReportComposer composer = new ReportComposer(new ReportMessages());

    private final StudyRef xray = study("DICOM_2D", "DX", List.of(2000, 2500, 1), List.of(0.14, 0.14));
    private final StudyRef ct = study("NIFTI", "CT", List.of(512, 512, 301), List.of(0.78, 0.78, 1.5));

    @Test
    void cxrTechniqueInVietnamese() {
        String technique = composer.technique(ReportTemplate.CXR, ReportLanguage.VI, xray,
                List.of(new ModelRef("cxr-multilabel", "0.1.0-xrv")));

        assertThat(technique).isEqualTo("""
                X-quang ngực, phương thức DX; ảnh 2000 × 2500 px, khoảng cách điểm ảnh 0,14 × 0,14 mm.
                Phân tích hỗ trợ bởi AI: cxr-multilabel 0.1.0-xrv.""");
    }

    @Test
    void ctTechniqueInEnglishWithoutAi() {
        String technique = composer.technique(ReportTemplate.CT, ReportLanguage.EN, ct, List.of());

        assertThat(technique).isEqualTo("""
                Computed tomography, modality CT; volume 512 × 512 × 301 voxels, voxel spacing 0.78 × 0.78 × 1.5 mm.
                No AI analysis results.""");
    }

    @Test
    void uncalibratedImageIsMeasuredInPixels() {
        StudyRef png = study("IMAGE_2D", null, List.of(300, 300, 1), null);

        assertThat(composer.technique(ReportTemplate.CXR, ReportLanguage.EN, png, List.of()))
                .startsWith("Chest radiograph, modality unknown; image 300 × 300 px, no pixel spacing, measurements in px.");
    }

    @Test
    void findingsInVietnameseListConfirmedFindingsThenAnnotations() {
        List<FindingDto> findings = List.of(
                finding("AI", "Effusion", new BigDecimal("0.8734"), null, "ACCEPTED", null, "bên phải"),
                finding("AI", "Mass", new BigDecimal("0.61"), null, "EDITED", "Nốt mờ", null),
                finding("MANUAL", "Gãy xương sườn", null, null, "ACCEPTED", null, "sườn 5 trái"));
        List<AnnotationDto> annotations = List.of(
                annotation("RECTANGLE", "Nốt mờ thuỳ trên", null, new MeasurementDto(null, null, 120.5, null, null, null)),
                annotation("LENGTH", null, "đo khí quản", new MeasurementDto(null, 42.0, null, null, null, null)),
                annotation("ARROW", null, null, null));

        assertThat(composer.findings(ReportLanguage.VI, findings, annotations)).isEqualTo("""
                - Effusion (AI, độ tin cậy 87%): bên phải
                - Nốt mờ (AI, độ tin cậy 61%)
                - Gãy xương sườn (bác sĩ thêm): sườn 5 trái

                Đánh dấu trên ảnh:
                - Nốt mờ thuỳ trên (hình chữ nhật, diện tích 120,5 mm²)
                - đo chiều dài (dài 42 px): đo khí quản""");
    }

    @Test
    void findingsInEnglishGiveSegmentedVolumesAndHuStatistics() {
        List<FindingDto> findings = List.of(finding("AI", "liver", null, new BigDecimal("1520.46"), "ACCEPTED", null, null));
        List<AnnotationDto> annotations = List.of(annotation("ELLIPSE_ROI", "Liver lesion", null,
                new MeasurementDto(null, null, 312.4, null, -12.25, 8.0)));

        assertThat(composer.findings(ReportLanguage.EN, findings, annotations)).isEqualTo("""
                - Liver (AI, volume 1,520.5 ml)

                Annotations:
                - Liver lesion (elliptical ROI, area 312.4 mm², mean -12.2 HU, SD 8 HU)""");
    }

    @Test
    void segmentedStructuresAreNamedInTheReportLanguageButTheDoctorsLabelsAreKept() {
        List<FindingDto> findings = List.of(
                finding("AI", "liver", null, new BigDecimal("1520.46"), "ACCEPTED", null, null),
                finding("AI", "hip", null, new BigDecimal("410"), "ACCEPTED", null, "gãy cũ"),
                finding("AI", "spine", null, new BigDecimal("380.24"), "EDITED", "spine", null),
                finding("AI", "kidney_left", null, new BigDecimal("150"), "EDITED", "Thận trái ứ nước", null),
                finding("MANUAL", "liver", null, null, "ACCEPTED", null, null));

        assertThat(composer.findings(ReportLanguage.VI, findings, List.of())).isEqualTo("""
                - Gan (AI, thể tích 1.520,5 ml)
                - Xương chậu (AI, thể tích 410 ml): gãy cũ
                - spine (AI, thể tích 380,2 ml)
                - Thận trái ứ nước (AI, thể tích 150 ml)
                - liver (bác sĩ thêm)""");
        assertThat(composer.findings(ReportLanguage.EN, findings.subList(0, 2), List.of())).isEqualTo("""
                - Liver (AI, volume 1,520.5 ml)
                - Hip bones (AI, volume 410 ml): gãy cũ""");
    }

    @Test
    void labelsThatAreNotSegmentedStructuresAreLeftAsTheModelGaveThem() {
        Locale vi = ReportLanguage.VI.locale();

        assertThat(composer.label(vi, finding("AI", "Pneumonia", new BigDecimal("0.7"), null, "ACCEPTED", null, null)))
                .isEqualTo("Pneumonia");
        assertThat(composer.label(vi, finding("AI", "Cardiomegaly", new BigDecimal("0.7"), null, "ACCEPTED", null, null)))
                .isEqualTo("Cardiomegaly");
        assertThat(composer.label(Locale.ENGLISH, finding("AI", "kidney_cyst", null, BigDecimal.ONE, "ACCEPTED", null, null)))
                .isEqualTo("kidney_cyst");
    }

    /** The 21 labels of {@code ct-totalseg}, named as in the viewer ({@code frontend/src/i18n/locales/*.ts}). */
    @ParameterizedTest(name = "{0}: {1} / {2}")
    @CsvSource(delimiter = '|', textBlock = """
            liver           | Gan               | Liver
            spleen          | Lách              | Spleen
            kidney_left     | Thận trái         | Left kidney
            kidney_right    | Thận phải         | Right kidney
            pancreas        | Tụy               | Pancreas
            stomach         | Dạ dày            | Stomach
            gallbladder     | Túi mật           | Gallbladder
            urinary_bladder | Bàng quang        | Urinary bladder
            lung_left       | Phổi trái         | Left lung
            lung_right      | Phổi phải         | Right lung
            heart           | Tim               | Heart
            aorta           | Động mạch chủ     | Aorta
            esophagus       | Thực quản         | Oesophagus
            trachea         | Khí quản          | Trachea
            colon           | Đại tràng         | Colon
            small_bowel     | Ruột non          | Small bowel
            spine           | Cột sống          | Spine
            ribs            | Xương sườn        | Ribs
            hip             | Xương chậu        | Hip bones
            femur           | Xương đùi         | Femurs
            adrenal_glands  | Tuyến thượng thận | Adrenal glands
            """)
    void everySegmentedStructureHasAVietnameseAndAnEnglishName(String label, String vi, String en) {
        FindingDto structure = finding("AI", label, null, BigDecimal.TEN, "ACCEPTED", null, null);

        assertThat(composer.label(ReportLanguage.VI.locale(), structure)).isEqualTo(vi);
        assertThat(composer.label(ReportLanguage.EN.locale(), structure)).isEqualTo(en);
    }

    @Test
    void noConfirmedFindingIsSaid() {
        assertThat(composer.findings(ReportLanguage.VI, List.of(), List.of()))
                .isEqualTo("Không có phát hiện nào được chấp nhận.");
    }

    @Test
    void signatureTimeIsInVietnamTimeForVietnameseAndUtcForEnglish() {
        assertThat(composer.dateTime(ReportLanguage.VI, SIGNED)).isEqualTo("26/11/2026 06:30 (giờ Việt Nam)");
        assertThat(composer.dateTime(ReportLanguage.EN, SIGNED)).isEqualTo("2026-11-25 23:30 UTC");
        assertThat(composer.date(ReportLanguage.VI, SIGNED)).isEqualTo("26/11/2026");
    }

    @Test
    void tableValuesAndSources() {
        Locale vi = ReportLanguage.VI.locale();
        FindingDto edited = finding("AI", "Mass", new BigDecimal("0.5"), null, "EDITED", "Nodule", null);
        FindingDto manual = finding("MANUAL", "Fracture", null, null, "ACCEPTED", null, null);

        assertThat(composer.tableValue(vi, edited)).isEqualTo("50%");
        assertThat(composer.tableValue(vi, manual)).isEmpty();
        assertThat(composer.source(vi, edited)).isEqualTo("AI, bác sĩ sửa nhãn");
        assertThat(composer.source(Locale.ENGLISH, manual)).isEqualTo("Doctor");
        assertThat(composer.label(vi, edited)).isEqualTo("Nodule");
        assertThat(composer.sex(vi, "F")).isEqualTo("Nữ");
        assertThat(composer.orUnknown(vi, null)).isEqualTo("—");
        assertThat(composer.title(ReportTemplate.CT, Locale.ENGLISH)).isEqualTo("Computed tomography (CT) report");
    }

    private static StudyRef study(String inputType, String modality, List<Integer> dims, List<Double> spacing) {
        UUID studyId = UUID.randomUUID();
        String normalized = "NIFTI".equals(inputType) ? "NIFTI" : "IMAGE_2D";
        return new StudyRef(studyId, UUID.randomUUID(), inputType, modality, null, SIGNED,
                List.of(new SeriesRef(studyId, UUID.randomUUID(), UUID.randomUUID(), inputType, modality, null, normalized,
                        "s3://medimg/x", dims, spacing)));
    }

    private static FindingDto finding(String source, String label, BigDecimal confidence, BigDecimal volume, String status,
                                      String editedLabel, String note) {
        return new FindingDto(UUID.randomUUID(), UUID.randomUUID(), source, label, confidence, volume, null, status,
                new ReviewDto(status, editedLabel, note, DOCTOR, SIGNED), null, 1);
    }

    private static AnnotationDto annotation(String kind, String label, String note, MeasurementDto measurement) {
        return new AnnotationDto(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), kind, null, label, note,
                measurement, DOCTOR, SIGNED, SIGNED, 0);
    }
}
