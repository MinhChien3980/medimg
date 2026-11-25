package com.medimg.prediction.domain;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.UUID;

import org.hibernate.annotations.ColumnTransformer;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "finding")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Finding {

    @Id
    private UUID id;

    @Column(name = "result_id", nullable = false)
    private UUID resultId;

    @Column(nullable = false)
    private String label;

    /** Null for segmentation findings. */
    private BigDecimal confidence;

    /** Segmented volume in ml; null for 2D findings. */
    @Column(name = "volume_ml")
    private BigDecimal volumeMl;

    /** JSON array [x1,y1,x2,y2] in image pixels, or null. */
    @Column(columnDefinition = "jsonb")
    @ColumnTransformer(write = "?::jsonb")
    private String bbox;

    @Column(name = "review_status", nullable = false)
    private String reviewStatus;

    public Finding(UUID resultId, String label, Double confidence, Double volumeMl, String bboxJson) {
        this.id = UUID.randomUUID();
        this.resultId = resultId;
        this.label = label;
        this.confidence = confidence == null ? null
                : BigDecimal.valueOf(Math.min(1.0, Math.max(0.0, confidence))).setScale(4, RoundingMode.HALF_UP);
        this.volumeMl = volumeMl == null ? null
                : BigDecimal.valueOf(Math.max(0.0, volumeMl)).setScale(2, RoundingMode.HALF_UP);
        this.bbox = bboxJson;
        this.reviewStatus = "PENDING";
    }
}
