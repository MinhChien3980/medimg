package com.medimg.imaging.domain;

import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "image_file")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class ImageFile {

    @Id
    private UUID id;

    @Column(name = "series_id", nullable = false)
    private UUID seriesId;

    @Column(name = "original_name")
    private String originalName;

    @Column(name = "content_type")
    private String contentType;

    @Column(name = "size_bytes")
    private Long sizeBytes;

    @Column(columnDefinition = "bpchar(64)")
    private String sha256;

    @Column(name = "storage_uri")
    private String storageKey;

    @Column(name = "instance_number")
    private Integer instanceNumber;

    public ImageFile(UUID seriesId, String originalName, String contentType, long sizeBytes, String sha256,
                     String storageKey, int instanceNumber) {
        this.id = UUID.randomUUID();
        this.seriesId = seriesId;
        this.originalName = originalName;
        this.contentType = contentType;
        this.sizeBytes = sizeBytes;
        this.sha256 = sha256;
        this.storageKey = storageKey;
        this.instanceNumber = instanceNumber;
    }
}
