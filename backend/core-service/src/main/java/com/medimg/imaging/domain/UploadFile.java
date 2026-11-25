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

    UploadFile(UUID id, String name, long sizeBytes, String contentType, String storageKey) {
        this.id = id;
        this.name = name;
        this.sizeBytes = sizeBytes;
        this.contentType = contentType;
        this.storageKey = storageKey;
    }
}
