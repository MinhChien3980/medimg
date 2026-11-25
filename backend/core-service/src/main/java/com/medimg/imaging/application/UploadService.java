package com.medimg.imaging.application;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.IntStream;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.FileTypeDetector.FileType;
import com.medimg.imaging.application.ImagingDtos.CompletedFile;
import com.medimg.imaging.application.ImagingDtos.FileSpec;
import com.medimg.imaging.application.ImagingDtos.InitUpload;
import com.medimg.imaging.application.ImagingDtos.InitUploadResponse;
import com.medimg.imaging.application.ImagingDtos.MultipartUpload;
import com.medimg.imaging.application.ImagingDtos.PartUrl;
import com.medimg.imaging.application.ImagingDtos.PresignedFile;
import com.medimg.imaging.application.ImagingDtos.UploadDto;
import com.medimg.imaging.domain.UploadFile;
import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.infrastructure.UploadSessionRepository;
import com.medimg.patient.application.PatientService;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.storage.MultipartUploadRejectedException;
import com.medimg.shared.storage.ObjectNotFoundException;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.storage.ObjectStoragePort.PresignedUrl;
import com.medimg.shared.storage.ObjectStoragePort.UploadedPart;
import com.medimg.shared.web.ApiException;

/**
 * Upload flow: init (presigned PUT, file goes browser → object storage directly, never through the JVM heap; a file
 * above the multipart threshold goes in parts, each with its own presigned URL) → complete (assemble the parts, verify
 * the object and its type from its first bytes) → poll status.
 * <ul>
 *   <li>a PNG or JPEG image is then processed asynchronously in this service;</li>
 *   <li>a DICOM file, a ZIP (DICOM series or stack of 2D images) or a NIfTI volume is handed to the ingest worker
 *       through the outbox, in the complete transaction.</li>
 * </ul>
 */
@Service
public class UploadService {

    private static final Logger log = LoggerFactory.getLogger(UploadService.class);

    static final String PARTS_REJECTED = "The storage rejected the uploaded parts, please upload the file again";

    /** Fired after the complete() transaction of a 2D image commits; {@link UploadProcessor} picks it up. */
    public record UploadCompleted(UUID uploadId) {
    }

    private final UploadSessionRepository uploads;
    private final PatientService patients;
    private final ObjectStoragePort storage;
    private final IngestDispatcher ingest;
    private final RawUploads rawUploads;
    private final ImagingProperties props;
    private final ApplicationEventPublisher events;
    private final Clock clock;

    UploadService(UploadSessionRepository uploads, PatientService patients, ObjectStoragePort storage,
                  IngestDispatcher ingest, RawUploads rawUploads, ImagingProperties props,
                  ApplicationEventPublisher events, Clock clock) {
        this.uploads = uploads;
        this.patients = patients;
        this.storage = storage;
        this.ingest = ingest;
        this.rawUploads = rawUploads;
        this.props = props;
        this.events = events;
        this.clock = clock;
    }

    @Transactional
    @Audited(action = "STUDY_UPLOAD", resource = "UPLOAD")
    public InitUploadResponse init(InitUpload cmd) {
        patients.requireExists(cmd.patientId());
        if (cmd.files() == null || cmd.files().size() != 1) {
            throw ApiException.badRequest("Exactly one file per upload is supported");
        }
        FileSpec spec = cmd.files().getFirst();
        UploadKind kind = UploadKind.of(spec.name(), spec.contentType())
                .orElseThrow(() -> ApiException.badRequest(UploadKind.UNSUPPORTED));
        long maxBytes = kind.maxBytes(props);
        if (spec.size() <= 0 || spec.size() > maxBytes) {
            throw ApiException.badRequest("File size must be between 1 byte and " + maxBytes / (1024 * 1024) + " MB");
        }
        if (cmd.sliceSpacingMm() != null && kind != UploadKind.ZIP) {
            throw ApiException.badRequest("sliceSpacingMm only applies to a ZIP of 2D image slices");
        }
        boolean volume = kind.isVolume();
        UploadSession session = new UploadSession(cmd.patientId(), upper(cmd.modalityHint(), volume ? "CT" : "CR"),
                upper(cmd.bodyPartHint(), volume ? null : "CHEST"), CurrentUser.id(), clock.instant());
        if (cmd.sliceSpacingMm() != null) {
            session.requestSpacing(cmd.sliceSpacingMm());
        }
        UploadFile file = session.addFile(spec.name(), spec.size(), spec.contentType());
        PresignedFile presigned = file.getSizeBytes() > props.multipart().threshold().toBytes()
                ? presignParts(file) : presignPut(file);
        uploads.save(session);
        return new InitUploadResponse(session.getId(), List.of(presigned));
    }

    private PresignedFile presignPut(UploadFile file) {
        PresignedUrl url = storage.presignPut(file.getStorageKey(), file.getContentType(), file.getSizeBytes());
        return new PresignedFile(file.getId(), file.getName(), url.url(), null, url.expiresAt());
    }

    private PresignedFile presignParts(UploadFile file) {
        ImagingProperties.Multipart multipart = props.multipart();
        String key = file.getStorageKey();
        file.uploadInParts(storage.createMultipartUpload(key, file.getContentType()),
                multipart.partCount(file.getSizeBytes()));
        List<PartUrl> parts = new ArrayList<>();
        Instant expiresAt = Instant.MAX;
        for (int n = 1; n <= file.getPartCount(); n++) {
            PresignedUrl url = storage.presignUploadPart(key, file.getMultipartUploadId(), n,
                    multipart.partLength(file.getSizeBytes(), n), multipart.urlValidity());
            parts.add(new PartUrl(n, url.url()));
            expiresAt = url.expiresAt().isBefore(expiresAt) ? url.expiresAt() : expiresAt;
        }
        return new PresignedFile(file.getId(), file.getName(), null,
                new MultipartUpload(multipart.partSize().toBytes(), parts), expiresAt);
    }

    /**
     * {@code files} lists the parts of a file uploaded in parts; it is required for such a file and not allowed for
     * one uploaded with a single PUT. A file whose content does not match what it was declared as at init, or whose
     * parts the storage rejects, fails right away.
     */
    @Transactional
    public UploadDto complete(UUID uploadId, List<CompletedFile> files) {
        UploadSession session = requireOwn(uploadId);
        if (session.getStatus() != UploadSession.Status.INIT) {
            return toDto(session); // idempotent: repeated complete() calls are harmless
        }
        UploadFile file = session.getFiles().getFirst();
        Instant now = clock.instant();
        Optional<List<UploadedPart>> parts = partsOf(file, files);
        if (parts.isPresent() && !assemble(session, file, parts.get(), now)) {
            return toDto(session);
        }
        requireStored(file);
        FileType detected = FileTypeDetector.detect(storage.getFirstBytes(file.getStorageKey(), FileTypeDetector.HEAD_BYTES));
        UploadKind kind = UploadKind.of(file.getName(), file.getContentType()).orElseThrow();
        if (!kind.matches(detected)) {
            session.markFailed(kind.mismatchMessage(), now);
            rawUploads.deleteAfterCommit(file.getStorageKey());
        } else if (kind.ingestInput().isPresent()) {
            session.markUploadedForIngest(kind.ingestInput().get(), now);
            ingest.dispatch(session, now);
        } else {
            session.markUploaded(now);
            events.publishEvent(new UploadCompleted(session.getId()));
        }
        return toDto(session);
    }

    /** The parts listed for the upload's file, checked against what was handed out at init: every part, once. */
    private static Optional<List<UploadedPart>> partsOf(UploadFile file, List<CompletedFile> files) {
        for (CompletedFile f : files) {
            if (!f.fileId().equals(file.getId())) {
                throw ApiException.badRequest("File " + f.fileId() + " is not part of this upload");
            }
        }
        if (!file.isMultipart()) {
            if (!files.isEmpty()) {
                throw ApiException.badRequest("File " + file.getName() + " was not uploaded in parts");
            }
            return Optional.empty();
        }
        if (files.size() != 1) {
            throw ApiException.badRequest("File " + file.getName() + " was uploaded in parts; list its parts once");
        }
        List<UploadedPart> parts = files.getFirst().parts().stream()
                .sorted(Comparator.comparingInt(UploadedPart::partNumber)).toList();
        boolean everyPartOnce = parts.size() == file.getPartCount()
                && IntStream.range(0, parts.size()).allMatch(i -> parts.get(i).partNumber() == i + 1);
        if (!everyPartOnce) {
            throw ApiException.badRequest("File " + file.getName() + " has " + file.getPartCount()
                    + " parts; list each of parts 1 to " + file.getPartCount() + " once with its ETag");
        }
        return Optional.of(parts);
    }

    /** False if the storage rejected the parts: the upload has failed and its multipart upload is dropped. */
    private boolean assemble(UploadSession session, UploadFile file, List<UploadedPart> parts, Instant now) {
        try {
            storage.completeMultipartUpload(file.getStorageKey(), file.getMultipartUploadId(), parts);
            return true;
        } catch (MultipartUploadRejectedException e) {
            log.warn("Upload {}: {}", session.getId(), e.getMessage());
            session.markFailed(PARTS_REJECTED, now);
            rawUploads.abortMultipartAfterCommit(file.getStorageKey(), file.getMultipartUploadId());
            return false;
        }
    }

    @Transactional(readOnly = true)
    public UploadDto get(UUID uploadId) {
        return toDto(requireOwn(uploadId));
    }

    private void requireStored(UploadFile f) {
        long actual;
        try {
            actual = storage.size(f.getStorageKey());
        } catch (ObjectNotFoundException e) {
            throw ApiException.conflict("File " + f.getName() + " has not been uploaded yet");
        }
        if (actual != f.getSizeBytes()) {
            throw ApiException.conflict("File " + f.getName() + " size mismatch (declared " + f.getSizeBytes()
                    + ", stored " + actual + ")");
        }
    }

    private UploadSession requireOwn(UUID uploadId) {
        UploadSession s = uploads.findById(uploadId).orElseThrow(() -> ApiException.notFound("Upload", uploadId));
        if (!s.getCreatedBy().equals(CurrentUser.id())) {
            throw ApiException.notFound("Upload", uploadId); // do not reveal other users' uploads
        }
        return s;
    }

    static UploadDto toDto(UploadSession s) {
        return new UploadDto(s.getId(), s.getStatus().name(), s.getProgress(),
                s.getInputType() == null ? null : s.getInputType().name(), s.getError(), s.getStudyId());
    }

    private static String upper(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value.trim().toUpperCase();
    }
}
