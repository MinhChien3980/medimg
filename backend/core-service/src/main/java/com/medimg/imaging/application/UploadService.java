package com.medimg.imaging.application;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.FileTypeDetector.FileType;
import com.medimg.imaging.application.ImagingDtos.FileSpec;
import com.medimg.imaging.application.ImagingDtos.InitUpload;
import com.medimg.imaging.application.ImagingDtos.InitUploadResponse;
import com.medimg.imaging.application.ImagingDtos.PresignedFile;
import com.medimg.imaging.application.ImagingDtos.UploadDto;
import com.medimg.imaging.domain.Study.InputType;
import com.medimg.imaging.domain.UploadFile;
import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.infrastructure.UploadSessionRepository;
import com.medimg.patient.application.PatientService;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.storage.ObjectNotFoundException;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.web.ApiException;

/**
 * Upload flow: init (presigned PUT, file goes browser → object storage directly, never through the JVM heap)
 * → complete (verify the object and its type from its first bytes) → poll status.
 * <ul>
 *   <li>a 2D image (PNG, JPEG) is then processed asynchronously in this service;</li>
 *   <li>a volume (ZIP of DICOM files, NIfTI) is handed to the ingest worker through the outbox, in the complete
 *       transaction.</li>
 * </ul>
 */
@Service
public class UploadService {

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
        boolean volume = kind == UploadKind.VOLUME;
        UploadSession session = new UploadSession(cmd.patientId(), upper(cmd.modalityHint(), volume ? "CT" : "CR"),
                upper(cmd.bodyPartHint(), volume ? null : "CHEST"), CurrentUser.id(), clock.instant());
        UploadFile file = session.addFile(spec.name(), spec.size(), spec.contentType());
        uploads.save(session);

        var url = storage.presignPut(file.getStorageKey(), file.getContentType(), file.getSizeBytes());
        return new InitUploadResponse(session.getId(),
                List.of(new PresignedFile(file.getId(), file.getName(), url.url(), url.expiresAt())));
    }

    /** A file whose content does not match what it was declared as at init fails right away. */
    @Transactional
    public UploadDto complete(UUID uploadId) {
        UploadSession session = requireOwn(uploadId);
        if (session.getStatus() != UploadSession.Status.INIT) {
            return toDto(session); // idempotent: repeated complete() calls are harmless
        }
        UploadFile file = session.getFiles().getFirst();
        requireStored(file);
        FileType detected = FileTypeDetector.detect(storage.getFirstBytes(file.getStorageKey(), FileTypeDetector.HEAD_BYTES));
        UploadKind kind = UploadKind.of(file.getName(), file.getContentType()).orElseThrow();
        Optional<InputType> inputType = kind.inputType(detected);
        Instant now = clock.instant();
        if (inputType.isEmpty()) {
            session.markFailed(kind.mismatchMessage(), now);
            rawUploads.deleteAfterCommit(file.getStorageKey());
        } else if (inputType.get().isVolume()) {
            session.markUploadedForIngest(inputType.get(), now);
            ingest.dispatch(session, now);
        } else {
            session.markUploaded(now);
            events.publishEvent(new UploadCompleted(session.getId()));
        }
        return toDto(session);
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
