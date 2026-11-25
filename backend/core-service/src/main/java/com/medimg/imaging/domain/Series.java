package com.medimg.imaging.domain;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * Storage keys are bucket-relative ({@code studies/{studyId}/series/{seriesId}/...}). A volume's dimensions are
 * {@code cols} (x), {@code rows} (y) and {@code numImages} (z), in the voxel order of its NIfTI file.
 */
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

    /** Spacing in mm: x, y and z for a volume, x and y for a calibrated 2D image (a DICOM X-ray), else none. */
    @Column(name = "spacing_x")
    private Double spacingX;

    @Column(name = "spacing_y")
    private Double spacingY;

    @Column(name = "spacing_z")
    private Double spacingZ;

    /** True when the spacing of a stack of 2D images was not given and 1 mm was assumed. */
    @Column(name = "spacing_assumed", nullable = false)
    private boolean spacingAssumed;

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

    /** {@code dims} and {@code spacing} are {@code [x, y, z]}. */
    public static Series volume(UUID id, UUID studyId, String modality, List<Integer> dims, List<Double> spacing,
                                boolean spacingAssumed, String volumeKey, String thumbnailKey, Instant now) {
        Series s = new Series(id, studyId, modality, dims.get(2), dims.get(1), dims.get(0), volumeKey, thumbnailKey, now);
        s.spacingX = spacing.get(0);
        s.spacingY = spacing.get(1);
        s.spacingZ = spacing.get(2);
        s.spacingAssumed = spacingAssumed;
        return s;
    }

    /** A 2D image; {@code pixelSpacing} ({@code [x, y]} mm) is null when the image is not calibrated (PNG, JPEG). */
    public static Series image(UUID id, UUID studyId, String modality, int width, int height, List<Double> pixelSpacing,
                               String imageKey, String thumbnailKey, Instant now) {
        Series s = new Series(id, studyId, modality, 1, height, width, imageKey, thumbnailKey, now);
        if (pixelSpacing != null) {
            s.spacingX = pixelSpacing.get(0);
            s.spacingY = pixelSpacing.get(1);
        }
        return s;
    }

    public List<Integer> dims() {
        return List.of(cols, rows, numImages);
    }

    /** Voxel spacing {@code [x, y, z]} of a volume; null for 2D images. */
    public List<Double> spacing() {
        return spacingZ == null ? null : List.of(spacingX, spacingY, spacingZ);
    }

    /** Pixel spacing {@code [x, y]} of a calibrated 2D image; null for volumes and uncalibrated images. */
    public List<Double> pixelSpacing() {
        return spacingX == null || spacingZ != null ? null : List.of(spacingX, spacingY);
    }
}
