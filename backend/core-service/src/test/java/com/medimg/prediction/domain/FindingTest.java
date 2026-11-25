package com.medimg.prediction.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.medimg.prediction.domain.Finding.ReviewStatus;
import com.medimg.prediction.domain.Finding.Source;

class FindingTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");
    private static final UUID DOCTOR = UUID.randomUUID();

    private final Finding ai = Finding.ai(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), "Effusion", 0.87, null,
            null);

    @Test
    void aiFindingIsPendingUntilReviewed() {
        assertThat(ai.getSource()).isEqualTo(Source.AI);
        assertThat(ai.getReviewStatus()).isEqualTo(ReviewStatus.PENDING);
        assertThat(ai.getReviewedBy()).isNull();
        assertThat(ai.effectiveLabel()).isEqualTo("Effusion");
    }

    @Test
    void acceptRecordsReviewerTimeAndNote() {
        ai.review(ReviewStatus.ACCEPTED, null, "  small, right side  ", DOCTOR, NOW);

        assertThat(ai.getReviewStatus()).isEqualTo(ReviewStatus.ACCEPTED);
        assertThat(ai.getReviewNote()).isEqualTo("small, right side");
        assertThat(ai.getReviewedBy()).isEqualTo(DOCTOR);
        assertThat(ai.getReviewedAt()).isEqualTo(NOW);
        assertThat(ai.getReviewLabel()).isNull();
    }

    @Test
    void editedFindingCarriesTheCorrectedLabel() {
        ai.review(ReviewStatus.EDITED, " Pleural effusion ", null, DOCTOR, NOW);

        assertThat(ai.getReviewLabel()).isEqualTo("Pleural effusion");
        assertThat(ai.effectiveLabel()).isEqualTo("Pleural effusion");
        assertThat(ai.getLabel()).isEqualTo("Effusion");
    }

    @Test
    void editRequiresALabelOfAtMost100Characters() {
        assertThatThrownBy(() -> ai.review(ReviewStatus.EDITED, " ", null, DOCTOR, NOW))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("label is required");
        assertThatThrownBy(() -> ai.review(ReviewStatus.EDITED, "x".repeat(101), null, DOCTOR, NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(ai.getReviewStatus()).isEqualTo(ReviewStatus.PENDING);
    }

    @Test
    void labelIsOnlyGivenWithEdited() {
        assertThatThrownBy(() -> ai.review(ReviewStatus.ACCEPTED, "Other", null, DOCTOR, NOW))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("only given with EDITED");
    }

    @Test
    void reviewCannotGoBackToPending() {
        assertThatThrownBy(() -> ai.review(ReviewStatus.PENDING, null, null, DOCTOR, NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ai.review(null, null, null, DOCTOR, NOW))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void noteIsAtMost1000Characters() {
        assertThatThrownBy(() -> ai.review(ReviewStatus.REJECTED, null, "n".repeat(1001), DOCTOR, NOW))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void laterReviewReplacesTheEarlierOne() {
        ai.review(ReviewStatus.EDITED, "Pleural effusion", "first look", DOCTOR, NOW);
        UUID other = UUID.randomUUID();

        ai.review(ReviewStatus.REJECTED, null, null, other, NOW.plusSeconds(60));

        assertThat(ai.getReviewStatus()).isEqualTo(ReviewStatus.REJECTED);
        assertThat(ai.getReviewLabel()).isNull();
        assertThat(ai.getReviewNote()).isNull();
        assertThat(ai.getReviewedBy()).isEqualTo(other);
        assertThat(ai.effectiveLabel()).isEqualTo("Effusion");
    }

    @Test
    void manualFindingIsAcceptedByItsAuthorAndNeverReviewed() {
        UUID annotation = UUID.randomUUID();
        Finding manual = Finding.manual(UUID.randomUUID(), UUID.randomUUID(), " Rib fracture ", "left 5th rib", annotation,
                DOCTOR, NOW);

        assertThat(manual.getSource()).isEqualTo(Source.MANUAL);
        assertThat(manual.getReviewStatus()).isEqualTo(ReviewStatus.ACCEPTED);
        assertThat(manual.getLabel()).isEqualTo("Rib fracture");
        assertThat(manual.getConfidence()).isNull();
        assertThat(manual.getResultId()).isNull();
        assertThat(manual.getAnnotationId()).isEqualTo(annotation);
        assertThat(manual.isManualBy(DOCTOR)).isTrue();
        assertThat(manual.isManualBy(UUID.randomUUID())).isFalse();
        assertThatThrownBy(() -> manual.review(ReviewStatus.REJECTED, null, null, DOCTOR, NOW))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void manualFindingNeedsALabel() {
        assertThatThrownBy(() -> Finding.manual(UUID.randomUUID(), UUID.randomUUID(), null, null, null, DOCTOR, NOW))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aiFindingIsNeverSomeonesManualFinding() {
        ai.review(ReviewStatus.ACCEPTED, null, null, DOCTOR, NOW);

        assertThat(ai.isManualBy(DOCTOR)).isFalse();
    }
}
