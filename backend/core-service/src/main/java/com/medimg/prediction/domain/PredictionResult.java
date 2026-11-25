package com.medimg.prediction.domain;

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
@Table(name = "prediction_result")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class PredictionResult {

    @Id
    private UUID id;

    @Column(name = "job_id", nullable = false, unique = true)
    private UUID jobId;

    /** Full worker payload, kept for traceability. */
    @Column(columnDefinition = "jsonb")
    @ColumnTransformer(write = "?::jsonb")
    private String summary;

    /** JSON object label → bucket-relative key of the heatmap PNG. */
    @Column(columnDefinition = "jsonb")
    @ColumnTransformer(write = "?::jsonb")
    private String heatmaps;

    @Column(name = "inference_ms")
    private Integer inferenceMs;

    public PredictionResult(UUID jobId, String summary, String heatmaps, Integer inferenceMs) {
        this.id = UUID.randomUUID();
        this.jobId = jobId;
        this.summary = summary;
        this.heatmaps = heatmaps;
        this.inferenceMs = inferenceMs;
    }
}
