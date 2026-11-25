package com.medimg.annotation.domain;

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
 * A shape drawn on a series, with an optional label, note and measurement. Its kind never changes; its geometry and
 * measurement are stored as their JSON form once validated against the series ({@link Geometry},
 * {@link Measurement}). Only its author changes or deletes it.
 */
@Entity
@Table(name = "annotation")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Annotation {

    @Id
    private UUID id;

    @Column(name = "study_id", nullable = false)
    private UUID studyId;

    @Column(name = "series_id", nullable = false)
    private UUID seriesId;

    @Column(name = "author_id", nullable = false)
    private UUID authorId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private AnnotationKind kind;

    @Column(columnDefinition = "jsonb", nullable = false)
    @ColumnTransformer(write = "?::jsonb")
    private String geometry;

    private String label;

    private String note;

    @Column(columnDefinition = "jsonb")
    @ColumnTransformer(write = "?::jsonb")
    private String measurement;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    public Annotation(UUID studyId, UUID seriesId, UUID authorId, AnnotationKind kind, String geometryJson,
                      String label, String note, String measurementJson, Instant now) {
        this.id = UUID.randomUUID();
        this.studyId = studyId;
        this.seriesId = seriesId;
        this.authorId = authorId;
        this.kind = kind;
        this.geometry = geometryJson;
        this.label = label;
        this.note = note;
        this.measurement = measurementJson;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public void update(String geometryJson, String label, String note, String measurementJson, Instant now) {
        this.geometry = geometryJson;
        this.label = label;
        this.note = note;
        this.measurement = measurementJson;
        this.updatedAt = now;
    }

    public boolean isAuthoredBy(UUID userId) {
        return authorId.equals(userId);
    }
}
