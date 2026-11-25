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
import jakarta.persistence.Version;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * An upload and its processing.
 * <pre>
 * INIT ─(complete, PNG/JPEG)─► UPLOADED ─► PROCESSING (in process) ─► DONE | FAILED
 * INIT ─(complete, other)────► UPLOADED ─(worker STARTED/PROGRESS)─► PROCESSING ─(DONE)─► DONE
 *                                 ▲                                      │
 *                                 └──(FAILED retryable, attempt &lt; max)──┘ (attempt+1)    otherwise ─► FAILED
 * INIT ─(multipart upload never completed)─► FAILED
 * </pre>
 * A DICOM file, a ZIP or a NIfTI volume is processed by the ingest worker. Its messages carry the attempt number;
 * messages of another attempt, and any message once the upload is DONE or FAILED, are ignored.
 */
@Entity
@Table(name = "upload_session")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class UploadSession {

    public enum Status { INIT, UPLOADED, PROCESSING, DONE, FAILED }

    public enum FailureOutcome { RETRY_SCHEDULED, FAILED }

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

    /** Known at complete for a PNG/JPEG, a DICOM file and a NIfTI volume; for a ZIP once the ingest worker is done. */
    @Enumerated(EnumType.STRING)
    @Column(name = "input_type")
    private Study.InputType inputType;

    /** What the ingest worker reads; null for a PNG/JPEG, which is processed in process. */
    @Enumerated(EnumType.STRING)
    @Column(name = "ingest_input")
    private IngestInput ingestInput;

    /** Voxel spacing in mm requested for a stack of 2D images. */
    @Column(name = "spacing_x")
    private Double spacingX;

    @Column(name = "spacing_y")
    private Double spacingY;

    @Column(name = "spacing_z")
    private Double spacingZ;

    @Column(nullable = false)
    private short progress;

    @Column(nullable = false)
    private short attempt;

    @Column(name = "reserved_study_id")
    private UUID reservedStudyId;

    @Column(name = "reserved_series_id")
    private UUID reservedSeriesId;

    @Column(name = "study_id")
    private UUID studyId;

    private String error;

    @Column(name = "created_by")
    private UUID createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at")
    private Instant updatedAt;

    @Version
    private long version;

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
        this.attempt = 1;
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

    /** {@code spacingMm} is {@code [x, y, z]}. */
    public void requestSpacing(List<Double> spacingMm) {
        requireStatus(Status.INIT);
        if (spacingMm.size() != 3) {
            throw new IllegalArgumentException("Spacing must have three values: " + spacingMm);
        }
        spacingX = spacingMm.get(0);
        spacingY = spacingMm.get(1);
        spacingZ = spacingMm.get(2);
    }

    /** The requested voxel spacing {@code [x, y, z]} in mm, or null. */
    public List<Double> requestedSpacing() {
        return spacingX == null ? null : List.of(spacingX, spacingY, spacingZ);
    }

    /** A PNG or JPEG image, processed in process. */
    public void markUploaded(Instant now) {
        requireStatus(Status.INIT);
        inputType = Study.InputType.IMAGE_2D;
        transition(Status.UPLOADED, now);
    }

    /** Handed to the ingest worker; the ids of the study and series it becomes are reserved now. */
    public void markUploadedForIngest(IngestInput input, Instant now) {
        requireStatus(Status.INIT);
        ingestInput = input;
        inputType = input.knownInputType();
        reservedStudyId = UUID.randomUUID();
        reservedSeriesId = UUID.randomUUID();
        transition(Status.UPLOADED, now);
    }

    public boolean isIngested() {
        return ingestInput != null;
    }

    /** Where the ingest worker writes the normalised image or volume and its thumbnail. */
    public String outputPrefix() {
        return "studies/" + reservedStudyId + "/series/" + reservedSeriesId + "/";
    }

    public boolean isTerminal() {
        return status == Status.DONE || status == Status.FAILED;
    }

    /** True if an ingest worker message for {@code messageAttempt} should still be applied. */
    public boolean accepts(int messageAttempt) {
        return !isTerminal() && messageAttempt == attempt;
    }

    public void markProcessing(Instant now) {
        requireStatus(Status.UPLOADED);
        transition(Status.PROCESSING, now);
    }

    /** Worker progress (0-100); never goes backwards within an attempt. Also counts as a sign of life. */
    public void recordProgress(int value, Instant now) {
        requireInProgress();
        progress = (short) Math.max(progress, Math.min(100, Math.max(0, value)));
        transition(Status.PROCESSING, now);
    }

    public void markDone(UUID studyId, Instant now) {
        requireInProgress();
        this.studyId = studyId;
        progress = 100;
        error = null;
        transition(Status.DONE, now);
    }

    /** The ingest worker is done: the study was created under the reserved id, as {@code result}. */
    public void markIngested(Study.InputType result, Instant now) {
        if (!isIngested() || !ingestInput.canBecome(result)) {
            throw new IllegalArgumentException(ingestInput + " input cannot become a " + result + " study");
        }
        markDone(reservedStudyId, now);
        inputType = result;
    }

    /** A failed ingest attempt: the next attempt starts right away (its dispatch waits for the backoff). */
    public FailureOutcome failAttempt(String error, boolean retryable, int maxAttempts, Instant now) {
        requireInProgress();
        if (retryable && attempt < maxAttempts) {
            attempt++;
            progress = 0;
            transition(Status.UPLOADED, now);
            return FailureOutcome.RETRY_SCHEDULED;
        }
        markFailed(error, now);
        return FailureOutcome.FAILED;
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

    private void requireInProgress() {
        if (status != Status.UPLOADED && status != Status.PROCESSING) {
            throw new IllegalStateException("Upload " + id + " is " + status + ", not in progress");
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
