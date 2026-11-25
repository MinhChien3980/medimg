package com.medimg.prediction.domain;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.UUID;

import org.hibernate.annotations.ColumnTransformer;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * A finding of a study, from an AI result ({@link Source#AI}) or added by a doctor ({@link Source#MANUAL}).
 * <pre>
 * AI:     PENDING ─(review)─► ACCEPTED | REJECTED | EDITED ─(review again)─► ACCEPTED | REJECTED | EDITED
 * MANUAL: ACCEPTED when added, its author being the reviewer; never reviewed, only deleted by its author
 * </pre>
 * An AI finding only exists once its job is DONE: the result and its findings are stored when the job completes.
 */
@Entity
@Table(name = "finding")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Finding {

    public enum Source { AI, MANUAL }

    public enum ReviewStatus { PENDING, ACCEPTED, REJECTED, EDITED }

    static final int MAX_LABEL = 100;
    static final int MAX_NOTE = 1000;

    @Id
    private UUID id;

    /** The AI result the finding comes from; null for a manual finding. */
    @Column(name = "result_id")
    private UUID resultId;

    @Column(name = "study_id", nullable = false)
    private UUID studyId;

    @Column(name = "series_id", nullable = false)
    private UUID seriesId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Source source;

    @Column(nullable = false)
    private String label;

    /** Null for segmentation and manual findings. */
    private BigDecimal confidence;

    /** Segmented volume in ml; null for 2D and manual findings. */
    @Column(name = "volume_ml")
    private BigDecimal volumeMl;

    /** JSON array [x1,y1,x2,y2] in image pixels, or null. */
    @Column(columnDefinition = "jsonb")
    @ColumnTransformer(write = "?::jsonb")
    private String bbox;

    @Enumerated(EnumType.STRING)
    @Column(name = "review_status", nullable = false)
    private ReviewStatus reviewStatus;

    /** The corrected label of an EDITED finding. */
    @Column(name = "review_label")
    private String reviewLabel;

    @Column(name = "review_note")
    private String reviewNote;

    @Column(name = "reviewed_by")
    private UUID reviewedBy;

    @Column(name = "reviewed_at")
    private Instant reviewedAt;

    /** The annotation a manual finding points at, if any. */
    @Column(name = "annotation_id")
    private UUID annotationId;

    @Version
    private long version;

    private Finding(UUID resultId, UUID studyId, UUID seriesId, Source source, String label) {
        this.id = UUID.randomUUID();
        this.resultId = resultId;
        this.studyId = studyId;
        this.seriesId = seriesId;
        this.source = source;
        this.label = label;
    }

    public static Finding ai(UUID resultId, UUID studyId, UUID seriesId, String label, Double confidence, Double volumeMl,
                             String bboxJson) {
        Finding f = new Finding(resultId, studyId, seriesId, Source.AI, label);
        f.confidence = confidence == null ? null
                : BigDecimal.valueOf(Math.min(1.0, Math.max(0.0, confidence))).setScale(4, RoundingMode.HALF_UP);
        f.volumeMl = volumeMl == null ? null
                : BigDecimal.valueOf(Math.max(0.0, volumeMl)).setScale(2, RoundingMode.HALF_UP);
        f.bbox = bboxJson;
        f.reviewStatus = ReviewStatus.PENDING;
        return f;
    }

    /** A finding a doctor adds by hand: accepted right away, the doctor being its author and reviewer. */
    public static Finding manual(UUID studyId, UUID seriesId, String label, String note, UUID annotationId, UUID author,
                                 Instant now) {
        Finding f = new Finding(null, studyId, seriesId, Source.MANUAL, requireLabel(label));
        f.reviewStatus = ReviewStatus.ACCEPTED;
        f.reviewNote = checkNote(note);
        f.annotationId = annotationId;
        f.reviewedBy = author;
        f.reviewedAt = now;
        return f;
    }

    /**
     * Records the review of an AI finding; a later review replaces it. {@code editedLabel} is required with EDITED and
     * not allowed otherwise.
     *
     * @throws IllegalStateException for a manual finding
     * @throws IllegalArgumentException for a review that does not fit the rules above
     */
    public void review(ReviewStatus status, String editedLabel, String note, UUID reviewer, Instant now) {
        if (source != Source.AI) {
            throw new IllegalStateException("A finding added by hand is accepted when added and is not reviewed");
        }
        if (status == null || status == ReviewStatus.PENDING) {
            throw new IllegalArgumentException("A review is ACCEPTED, REJECTED or EDITED");
        }
        String corrected = trimToNull(editedLabel);
        if (status == ReviewStatus.EDITED) {
            corrected = requireLabel(corrected);
        } else if (corrected != null) {
            throw new IllegalArgumentException("A label is only given with EDITED");
        }
        this.reviewStatus = status;
        this.reviewLabel = corrected;
        this.reviewNote = checkNote(note);
        this.reviewedBy = reviewer;
        this.reviewedAt = now;
    }

    public boolean isManualBy(UUID userId) {
        return source == Source.MANUAL && reviewedBy.equals(userId);
    }

    /** The label a report states: the corrected one of an EDITED finding, else the original. */
    public String effectiveLabel() {
        return reviewLabel != null ? reviewLabel : label;
    }

    private static String requireLabel(String label) {
        String value = trimToNull(label);
        if (value == null || value.length() > MAX_LABEL) {
            throw new IllegalArgumentException("label is required, at most " + MAX_LABEL + " characters");
        }
        return value;
    }

    private static String checkNote(String note) {
        String value = trimToNull(note);
        if (value != null && value.length() > MAX_NOTE) {
            throw new IllegalArgumentException("note must be at most " + MAX_NOTE + " characters");
        }
        return value;
    }

    private static String trimToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
