package com.medimg.prediction.domain;

import java.time.Instant;
import java.util.Arrays;
import java.util.UUID;

import org.hibernate.annotations.ColumnTransformer;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "ai_model")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class AiModel {

    public enum Task { CLASSIFICATION_2D, DETECTION_2D, SEGMENTATION_3D }

    public enum Status { STAGING, ACTIVE, RETIRED }

    @Id
    private UUID id;

    @Column(nullable = false)
    private String code;

    @Column(nullable = false)
    private String version;

    private String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Task task;

    @Column(name = "input_types", nullable = false)
    private String inputTypes;

    private String modality;

    @Column(name = "body_part")
    private String bodyPart;

    /** JSON array of label names. */
    @Column(columnDefinition = "jsonb")
    @ColumnTransformer(write = "?::jsonb")
    private String labels;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Status status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    public boolean accepts(String inputType) {
        return Arrays.stream(inputTypes.split(",")).map(String::trim).anyMatch(t -> t.equalsIgnoreCase(inputType));
    }

    public boolean is3d() {
        return task == Task.SEGMENTATION_3D;
    }
}
