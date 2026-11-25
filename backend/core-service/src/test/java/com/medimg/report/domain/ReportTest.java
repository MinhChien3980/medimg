package com.medimg.report.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

class ReportTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");
    private static final UUID STUDY = UUID.randomUUID();
    private static final UUID DOCTOR = UUID.randomUUID();
    private static final ReportContent CONTENT = new ReportContent(" cough ", "Chest X-ray", "- Effusion", "Small effusion");

    private final Report draft = Report.first(STUDY, ReportTemplate.CXR, ReportLanguage.VI, CONTENT, DOCTOR, NOW);

    @Test
    void firstVersionIsADraftOfTheAuthor() {
        assertThat(draft.getVersion()).isEqualTo(1);
        assertThat(draft.getStatus()).isEqualTo(ReportStatus.DRAFT);
        assertThat(draft.getAmendsReportId()).isNull();
        assertThat(draft.isAuthoredBy(DOCTOR)).isTrue();
        assertThat(draft.getClinicalInfo()).isEqualTo("cough");
        assertThat(draft.getPdfKey()).isNull();
    }

    @Test
    void blankSectionsAreEmpty() {
        assertThat(new ReportContent("  ", null, "\n", "x").clinicalInfo()).isNull();
        assertThat(new ReportContent("  ", null, "\n", "x").findingsText()).isNull();
    }

    @Test
    void signingMakesTheReportFinalWithItsPdfAndCitedFindings() {
        UUID finding = UUID.randomUUID();
        UUID signer = UUID.randomUUID();

        draft.sign(signer, List.of(finding), NOW.plusSeconds(60));

        assertThat(draft.isFinal()).isTrue();
        assertThat(draft.getSignedBy()).isEqualTo(signer);
        assertThat(draft.getSignedAt()).isEqualTo(NOW.plusSeconds(60));
        assertThat(draft.getPdfKey()).isEqualTo("reports/" + draft.getId() + "/report.pdf");
        assertThat(draft.getCitedFindings()).containsExactly(finding);
    }

    @Test
    void signingNeedsAnImpression() {
        draft.edit(new ReportContent(null, null, null, "   "), NOW);

        assertThatThrownBy(() -> draft.sign(DOCTOR, List.of(), NOW)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("impression");
        assertThat(draft.isFinal()).isFalse();
    }

    @Test
    void signingNeedsEveryKeyImageUploaded() {
        draft.addKeyImage("PA view", NOW);

        assertThatThrownBy(() -> draft.sign(DOCTOR, List.of(), NOW)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("key image");
    }

    @Test
    void finalReportNeverChanges() {
        KeyImage image = draft.addKeyImage(null, NOW);
        draft.markKeyImageUploaded(image.getId(), NOW);
        draft.sign(DOCTOR, List.of(), NOW);

        assertThatThrownBy(() -> draft.edit(CONTENT, NOW)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> draft.addKeyImage(null, NOW)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> draft.removeKeyImage(image.getId(), NOW)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> draft.sign(DOCTOR, List.of(), NOW)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> draft.refill("CT", "- Gan", NOW)).isInstanceOf(IllegalStateException.class);
        assertThat(draft.getFindingsText()).isEqualTo("- Effusion");
    }

    @Test
    void refillingReplacesThePrefilledSectionsAndKeepsTheDoctorsOwn() {
        Instant later = NOW.plusSeconds(600);

        draft.refill(" Chest X-ray, PA ", "- Effusion\n- Mass", later);

        assertThat(draft.content()).isEqualTo(new ReportContent("cough", "Chest X-ray, PA", "- Effusion\n- Mass",
                "Small effusion"));
        assertThat(draft.getUpdatedAt()).isEqualTo(later);
    }

    @Test
    void amendmentIsTheNextVersionStartingFromTheFinalContentAndKeyImages() {
        KeyImage image = draft.addKeyImage("PA view", NOW);
        draft.markKeyImageUploaded(image.getId(), NOW);
        draft.sign(DOCTOR, List.of(), NOW);
        UUID other = UUID.randomUUID();

        Report v2 = draft.amend(other, NOW.plusSeconds(3600));

        assertThat(v2.getVersion()).isEqualTo(2);
        assertThat(v2.getStatus()).isEqualTo(ReportStatus.DRAFT);
        assertThat(v2.getAmendsReportId()).isEqualTo(draft.getId());
        assertThat(v2.getStudyId()).isEqualTo(STUDY);
        assertThat(v2.getTemplate()).isEqualTo(ReportTemplate.CXR);
        assertThat(v2.getLanguage()).isEqualTo(ReportLanguage.VI);
        assertThat(v2.content()).isEqualTo(draft.content());
        assertThat(v2.isAuthoredBy(other)).isTrue();
        assertThat(v2.getSignedBy()).isNull();
        assertThat(v2.getCitedFindings()).isEmpty();
        KeyImage copy = v2.getKeyImages().getFirst();
        assertThat(copy.getId()).isNotEqualTo(image.getId());
        assertThat(copy.getObjectKey()).startsWith("reports/" + v2.getId() + "/key-images/");
        assertThat(copy.getCaption()).isEqualTo("PA view");
        assertThat(copy.isUploaded()).isTrue();
    }

    @Test
    void onlyAFinalReportIsAmended() {
        assertThatThrownBy(() -> draft.amend(DOCTOR, NOW)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void atMostSixKeyImagesNumberedInOrder() {
        for (int i = 0; i < Report.MAX_KEY_IMAGES; i++) {
            assertThat(draft.addKeyImage("image " + i, NOW).getPosition()).isEqualTo((short) (i + 1));
        }

        assertThatThrownBy(() -> draft.addKeyImage(null, NOW)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("at most 6");
    }

    @Test
    void removingAKeyImageMovesTheFollowingOnesUp() {
        KeyImage first = draft.addKeyImage("a", NOW);
        KeyImage second = draft.addKeyImage("b", NOW);
        KeyImage third = draft.addKeyImage("c", NOW);

        assertThat(draft.removeKeyImage(first.getId(), NOW)).isSameAs(first);

        assertThat(draft.getKeyImages()).containsExactly(second, third);
        assertThat(second.getPosition()).isEqualTo((short) 1);
        assertThat(third.getPosition()).isEqualTo((short) 2);
    }

    @Test
    void keyImagesAreRearrangedWithNewCaptions() {
        KeyImage a = draft.addKeyImage("a", NOW);
        KeyImage b = draft.addKeyImage("b", NOW);

        draft.arrangeKeyImages(List.of(b.getId(), a.getId()), Map.of(a.getId(), " lateral "), NOW);

        assertThat(draft.getKeyImages()).containsExactly(b, a);
        assertThat(b.getPosition()).isEqualTo((short) 1);
        assertThat(b.getCaption()).isEqualTo("b");
        assertThat(a.getCaption()).isEqualTo("lateral");
    }

    @Test
    void rearrangingListsEveryKeyImageOnce() {
        KeyImage a = draft.addKeyImage("a", NOW);
        draft.addKeyImage("b", NOW);

        assertThatThrownBy(() -> draft.arrangeKeyImages(List.of(a.getId(), a.getId()), Map.of(), NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> draft.arrangeKeyImages(List.of(a.getId()), Map.of(), NOW))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void captionIsAtMost200Characters() {
        assertThatThrownBy(() -> draft.addKeyImage("c".repeat(201), NOW)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void languageGivesTheTimeZoneOfTheReport() {
        assertThat(ReportLanguage.of("vi").zone().getId()).isEqualTo("Asia/Ho_Chi_Minh");
        assertThat(ReportLanguage.of("en").zone().getId()).isEqualTo("Z");
        assertThat(ReportLanguage.EN.locale().getLanguage()).isEqualTo("en");
        assertThatThrownBy(() -> ReportLanguage.of("fr")).isInstanceOf(IllegalArgumentException.class);
        assertThat(new ReportLanguage.Converter().convertToEntityAttribute("vi")).isEqualTo(ReportLanguage.VI);
        assertThat(new ReportLanguage.Converter().convertToDatabaseColumn(ReportLanguage.EN)).isEqualTo("en");
    }

    @Test
    void templateDefaultsToTheInput() {
        assertThat(ReportTemplate.defaultFor(false)).isEqualTo(ReportTemplate.CXR);
        assertThat(ReportTemplate.defaultFor(true)).isEqualTo(ReportTemplate.CT);
    }
}
