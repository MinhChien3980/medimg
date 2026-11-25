package com.medimg.report.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import javax.imageio.ImageIO;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;

import com.medimg.report.application.ReportDocument;
import com.medimg.report.application.ReportDocument.Amendment;
import com.medimg.report.application.ReportDocument.CaseInfo;
import com.medimg.report.application.ReportDocument.Figure;
import com.medimg.report.application.ReportDocument.FindingRow;
import com.medimg.report.application.ReportDocument.Signature;
import com.medimg.report.application.ReportDocument.StudyInfo;
import com.medimg.report.application.ReportMessages;

class HtmlReportPdfRendererTest {

    private final HtmlReportPdfRenderer renderer = new HtmlReportPdfRenderer(new ReportMessages());

    @Test
    void vietnameseDraftHasTheBannerWatermarkAndPageNumbers() throws IOException {
        byte[] pdf = renderer.render(document(Locale.of("vi"), true, null, null));

        assertThat(new String(pdf, 0, 5)).isEqualTo("%PDF-");
        try (PDDocument doc = Loader.loadPDF(pdf)) {
            PDFTextStripper stripper = new PDFTextStripper();
            stripper.setSortByPosition(true);
            String text = stripper.getText(doc);
            assertThat(text)
                    .contains("Bản demo nghiên cứu – không dùng cho chẩn đoán")
                    .contains("BẢN NHÁP")
                    .contains("CASE-7Q2K9P")
                    .contains("Tràn dịch màng phổi phải lượng ít")
                    .contains("Hình ảnh chính")
                    .contains("1. Phim thẳng")
                    .contains("Chưa ký")
                    .contains("Trang 1 / " + doc.getNumberOfPages());
            assertThat(fonts(doc)).isNotEmpty().allMatch(name -> name.contains("NotoSans"));
        }
    }

    @Test
    void finalEnglishReportIsSignedAndNamesTheReportItAmends() throws IOException {
        byte[] pdf = renderer.render(document(Locale.ENGLISH, false, new Signature("Demo Doctor", "2026-11-25 10:00 UTC"),
                new Amendment(1, "2026-11-20")));

        try (PDDocument doc = Loader.loadPDF(pdf)) {
            String text = new PDFTextStripper().getText(doc);
            assertThat(text)
                    .contains("Research demo – not for diagnostic use")
                    .contains("Amends report v1 of 2026-11-20")
                    .contains("Demo Doctor")
                    .contains("2026-11-25 10:00 UTC")
                    .doesNotContain("DRAFT");
        }
    }

    @Test
    void textIsInsertedEscapedNotAsMarkup() throws IOException {
        byte[] pdf = renderer.render(document(Locale.ENGLISH, true, null, null));

        try (PDDocument doc = Loader.loadPDF(pdf)) {
            assertThat(new PDFTextStripper().getText(doc)).contains("<b>not bold</b> & <script>");
        }
    }

    private static ReportDocument document(Locale locale, boolean draft, Signature signature, Amendment amendment)
            throws IOException {
        return new ReportDocument(locale, "Báo cáo X-quang ngực", draft, amendment == null ? 1 : 2, amendment,
                new CaseInfo("CASE-7Q2K9P", "1968", "Nữ"), new StudyInfo("DX", "25/11/2026", "2000 × 2500 px"),
                "Ho kéo dài 3 tuần", "X-quang ngực, phương thức DX.", "- Effusion (AI, độ tin cậy 87%)",
                "Tràn dịch màng phổi phải lượng ít.\n<b>not bold</b> & <script>",
                List.of(new FindingRow("Effusion", "AI", "87%", "bên phải"), new FindingRow("Gãy xương sườn", "Bác sĩ", "", null)),
                List.of(new Figure("Phim thẳng", png())), signature);
    }

    private static List<String> fonts(PDDocument doc) throws IOException {
        var resources = doc.getPage(0).getResources();
        List<String> names = new ArrayList<>();
        for (var name : resources.getFontNames()) {
            PDFont font = resources.getFont(name);
            names.add(font.getName());
        }
        return names;
    }

    private static byte[] png() throws IOException {
        BufferedImage image = new BufferedImage(64, 48, BufferedImage.TYPE_BYTE_GRAY);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }
}
