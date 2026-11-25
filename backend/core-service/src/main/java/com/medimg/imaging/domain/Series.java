package com.medimg.imaging.domain;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/** Storage keys are bucket-relative ({@code studies/{studyId}/series/{seriesId}/...}). */
@Entity
@Table(name = "series")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Series {

    @Id
    private UUID id;

    @Column(name = "study_id", nullable = false)
    private UUID studyId;

    private String modality;

    @Column(name = "num_images")
    private Integer numImages;

    @Column(name = "rows")
    private Integer rows;

    @Column(name = "cols")
    private Integer cols;

    /** Key of the normalised image (2D) or volume (3D). */
    @Column(name = "volume_uri")
    private String imageKey;

    @Column(name = "thumbnail_uri")
    private String thumbnailKey;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    public Series(UUID id, UUID studyId, String modality, int numImages, int rows, int cols, String imageKey,
                  String thumbnailKey, Instant now) {
        this.id = id;
        this.studyId = studyId;
        this.modality = modality;
        this.numImages = numImages;
        this.rows = rows;
        this.cols = cols;
        this.imageKey = imageKey;
        this.thumbnailKey = thumbnailKey;
        this.createdAt = now;
    }
}
