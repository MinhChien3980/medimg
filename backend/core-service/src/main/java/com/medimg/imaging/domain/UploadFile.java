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
@Table(name = "upload_file")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class UploadFile {

    @Id
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    @Column(name = "content_type", nullable = false)
    private String contentType;

    @Column(name = "storage_key", nullable = false)
    private String storageKey;

    /** Set when the file is uploaded in parts (S3 multipart upload); null for a single PUT. */
    @Column(name = "multipart_upload_id")
    private String multipartUploadId;

    @Column(name = "part_count")
    private Integer partCount;

    UploadFile(UUID id, String name, long sizeBytes, String contentType, String storageKey) {
        this.id = id;
        this.name = name;
        this.sizeBytes = sizeBytes;
        this.contentType = contentType;
        this.storageKey = storageKey;
    }

    public void uploadInParts(String multipartUploadId, int partCount) {
        if (partCount < 1) {
            throw new IllegalArgumentException("A multipart upload has at least one part");
        }
        this.multipartUploadId = multipartUploadId;
        this.partCount = partCount;
    }

    public boolean isMultipart() {
        return multipartUploadId != null;
    }
}
