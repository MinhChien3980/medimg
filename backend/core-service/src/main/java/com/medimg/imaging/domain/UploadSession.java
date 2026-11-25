package com.medimg.imaging.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "upload_session")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class UploadSession {

    public enum Status { INIT, UPLOADED, PROCESSING, DONE, FAILED }

    @Id
    private UUID id;

    @Column(name = "patient_id", nullable = false)
    private UUID patientId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Status status;

    @Column(name = "modality_hint")
    private String modalityHint;

    @Column(name = "body_part_hint")
    private String bodyPartHint;

    @Column(name = "file_count", nullable = false)
    private int fileCount;

    @Column(name = "total_bytes", nullable = false)
    private long totalBytes;

    @Column(name = "study_id")
    private UUID studyId;

    private String error;

    @Column(name = "created_by")
    private UUID createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at")
    private Instant updatedAt;

    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)
    @JoinColumn(name = "upload_id", nullable = false, updatable = false)
    private List<UploadFile> files = new ArrayList<>();

    public UploadSession(UUID patientId, String modalityHint, String bodyPartHint, UUID createdBy, Instant now) {
        this.id = UUID.randomUUID();
        this.patientId = patientId;
        this.modalityHint = modalityHint;
        this.bodyPartHint = bodyPartHint;
        this.createdBy = createdBy;
        this.status = Status.INIT;
        this.createdAt = now;
    }

    public UploadFile addFile(String name, long size, String contentType) {
        UUID fileId = UUID.randomUUID();
        String key = "uploads/" + id + "/" + fileId + "/" + safeName(name);
        UploadFile f = new UploadFile(fileId, name, size, contentType, key);
        files.add(f);
        fileCount = files.size();
        totalBytes += size;
        return f;
    }

    public void markUploaded(Instant now) {
        requireStatus(Status.INIT);
        transition(Status.UPLOADED, now);
    }

    public void markProcessing(Instant now) {
        requireStatus(Status.UPLOADED);
        transition(Status.PROCESSING, now);
    }

    public void markDone(UUID studyId, Instant now) {
        requireStatus(Status.PROCESSING);
        this.studyId = studyId;
        transition(Status.DONE, now);
    }

    public void markFailed(String error, Instant now) {
        this.error = error;
        transition(Status.FAILED, now);
    }

    private void requireStatus(Status expected) {
        if (status != expected) {
            throw new IllegalStateException("Upload " + id + " is " + status + ", expected " + expected);
        }
    }

    private void transition(Status next, Instant now) {
        this.status = next;
        this.updatedAt = now;
    }

    static String safeName(String name) {
        String base = name.replace('\\', '/');
        base = base.substring(base.lastIndexOf('/') + 1);
        base = base.replaceAll("[^A-Za-z0-9._-]", "_");
        if (base.isBlank() || base.startsWith(".")) {
            base = "file" + base;
        }
        return base.length() > 100 ? base.substring(base.length() - 100) : base;
    }
}
