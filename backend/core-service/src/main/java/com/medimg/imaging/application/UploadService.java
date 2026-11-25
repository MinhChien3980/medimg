package com.medimg.imaging.application;

import java.time.Clock;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.ImagingDtos.FileSpec;
import com.medimg.imaging.application.ImagingDtos.InitUpload;
import com.medimg.imaging.application.ImagingDtos.InitUploadResponse;
import com.medimg.imaging.application.ImagingDtos.PresignedFile;
import com.medimg.imaging.application.ImagingDtos.UploadDto;
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
 * → complete (verify the object, then process asynchronously) → poll status.
 */
@Service
public class UploadService {

    static final Set<String> ALLOWED_2D_TYPES = Set.of("image/png", "image/jpeg");

    /** Fired after the complete() transaction commits; {@link UploadProcessor} picks it up. */
    public record UploadCompleted(UUID uploadId) {
    }

    private final UploadSessionRepository uploads;
    private final PatientService patients;
    private final ObjectStoragePort storage;
    private final ImagingProperties props;
    private final ApplicationEventPublisher events;
    private final Clock clock;

    UploadService(UploadSessionRepository uploads, PatientService patients, ObjectStoragePort storage,
                  ImagingProperties props, ApplicationEventPublisher events, Clock clock) {
        this.uploads = uploads;
        this.patients = patients;
        this.storage = storage;
        this.props = props;
        this.events = events;
        this.clock = clock;
    }

    @Transactional
    @Audited(action = "STUDY_UPLOAD", resource = "UPLOAD")
    public InitUploadResponse init(InitUpload cmd) {
        patients.requireExists(cmd.patientId());
        if (cmd.files() == null || cmd.files().size() != 1) {
            throw ApiException.badRequest("Exactly one file (PNG or JPEG) per upload is supported");
        }
        FileSpec spec = cmd.files().getFirst();
        if (!ALLOWED_2D_TYPES.contains(spec.contentType())) {
            throw ApiException.badRequest("Unsupported content type " + spec.contentType() + "; use image/png or image/jpeg");
        }
        if (spec.size() <= 0 || spec.size() > props.maxUploadBytes()) {
            throw ApiException.badRequest("File size must be between 1 byte and " + props.maxUploadBytes() / (1024 * 1024) + " MB");
        }
        UploadSession session = new UploadSession(cmd.patientId(), upper(cmd.modalityHint(), "CR"),
                upper(cmd.bodyPartHint(), "CHEST"), CurrentUser.id(), clock.instant());
        UploadFile file = session.addFile(spec.name(), spec.size(), spec.contentType());
        uploads.save(session);

        var url = storage.presignPut(file.getStorageKey(), file.getContentType(), file.getSizeBytes());
        return new InitUploadResponse(session.getId(),
                List.of(new PresignedFile(file.getId(), file.getName(), url.url(), url.expiresAt())));
    }

    @Transactional
    public UploadDto complete(UUID uploadId) {
        UploadSession session = requireOwn(uploadId);
        if (session.getStatus() != UploadSession.Status.INIT) {
            return toDto(session); // idempotent: repeated complete() calls are harmless
        }
        for (UploadFile f : session.getFiles()) {
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
        session.markUploaded(clock.instant());
        events.publishEvent(new UploadCompleted(session.getId()));
        return toDto(session);
    }

    @Transactional(readOnly = true)
    public UploadDto get(UUID uploadId) {
        return toDto(requireOwn(uploadId));
    }

    private UploadSession requireOwn(UUID uploadId) {
        UploadSession s = uploads.findById(uploadId).orElseThrow(() -> ApiException.notFound("Upload", uploadId));
        if (!s.getCreatedBy().equals(CurrentUser.id())) {
            throw ApiException.notFound("Upload", uploadId); // do not reveal other users' uploads
        }
        return s;
    }

    static UploadDto toDto(UploadSession s) {
        return new UploadDto(s.getId(), s.getStatus().name(), s.getError(), s.getStudyId());
    }

    private static String upper(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value.trim().toUpperCase();
    }
}
