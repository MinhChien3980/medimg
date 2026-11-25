package com.medimg.imaging.application;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.IngestResult.Payload;
import com.medimg.imaging.domain.Series;
import com.medimg.imaging.domain.Study;
import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.domain.UploadSession.FailureOutcome;
import com.medimg.imaging.infrastructure.SeriesRepository;
import com.medimg.imaging.infrastructure.StudyRepository;
import com.medimg.imaging.infrastructure.UploadSessionRepository;
import com.medimg.patient.application.PatientService;
import com.medimg.shared.storage.ObjectStoragePort;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

/**
 * Applies ingest worker messages ({@code imaging.results}) to the upload. Idempotent and attempt-aware, like the AI
 * result handling: DONE creates the study and series under the ids reserved at complete.
 */
@Service
public class IngestResultHandler {

    private static final Logger log = LoggerFactory.getLogger(IngestResultHandler.class);

    static final String UNREADABLE_RESULT = "The ingest worker returned an unreadable result";

    private final UploadSessionRepository uploads;
    private final StudyRepository studies;
    private final SeriesRepository series;
    private final IngestDispatcher dispatcher;
    private final PatientService patients;
    private final RawUploads rawUploads;
    private final ObjectStoragePort storage;
    private final ImagingProperties props;
    private final ObjectMapper json;
    private final Clock clock;

    IngestResultHandler(UploadSessionRepository uploads, StudyRepository studies, SeriesRepository series,
                        IngestDispatcher dispatcher, PatientService patients, RawUploads rawUploads,
                        ObjectStoragePort storage, ImagingProperties props, ObjectMapper json, Clock clock) {
        this.uploads = uploads;
        this.studies = studies;
        this.series = series;
        this.dispatcher = dispatcher;
        this.patients = patients;
        this.rawUploads = rawUploads;
        this.storage = storage;
        this.props = props;
        this.json = json;
        this.clock = clock;
    }

    @Transactional
    public void handle(IngestResult r) {
        UploadSession upload = uploads.findById(r.uploadId()).orElse(null);
        if (upload == null || !upload.isVolume()) {
            log.warn("Ingest result for unknown upload {} ignored", r.uploadId());
            return;
        }
        Instant now = clock.instant();
        if (isRejectedJobMessage(r)) {
            if (!upload.isTerminal()) {
                fail(upload, r.error(), false, now);
                dispatcher.discardPending(upload.getId());
            }
            return;
        }
        if (!upload.accepts(r.attempt())) {
            log.debug("Stale {} for upload {} (attempt {}, upload attempt {}, status {}) ignored",
                    r.type(), r.uploadId(), r.attempt(), upload.getAttempt(), upload.getStatus());
            return;
        }
        switch (r.type()) {
            case STARTED -> upload.recordProgress(0, now);
            case PROGRESS -> upload.recordProgress(r.progress(), now);
            case DONE -> complete(upload, r.payloadJson(), now);
            case FAILED -> fail(upload, r.error(), r.retryable(), now);
        }
    }

    private void complete(UploadSession upload, String payloadJson, Instant now) {
        Volume volume;
        try {
            volume = readVolume(upload, payloadJson);
        } catch (JacksonException | IllegalArgumentException e) {
            log.error("Upload {}: unreadable DONE payload: {}", upload.getId(), e.getMessage());
            fail(upload, UNREADABLE_RESULT, false, now);
            return;
        }
        String modality = volume.payload().modality() == null || volume.payload().modality().isBlank()
                ? upload.getModalityHint() : volume.payload().modality().trim().toUpperCase(Locale.ROOT);
        Study study = studies.save(new Study(upload.getReservedStudyId(), upload.getPatientId(), upload.getInputType(),
                modality, upload.getBodyPartHint(), upload.getCreatedBy(), now));
        series.save(Series.volume(upload.getReservedSeriesId(), study.getId(), modality, volume.payload().dims(),
                volume.payload().spacing(), volume.volumeKey(), volume.thumbnailKey(), now));
        upload.markDone(study.getId(), now);
        rawUploads.deleteAfterCommit(rawKey(upload));
        log.info("Upload {} ingested into study {} ({} {})", upload.getId(), study.getId(), upload.getInputType(),
                volume.payload().dims());
    }

    /**
     * A retry is dispatched in this transaction, due after the backoff. Uploads of a deleted case are not retried.
     * The raw upload is deleted once the upload has failed for good: it cannot be resumed, only uploaded again.
     */
    private void fail(UploadSession upload, String error, boolean retryable, Instant now) {
        String message = error == null || error.isBlank() ? "Processing failed, please upload the file again" : error;
        boolean retry = retryable && patients.exists(upload.getPatientId());
        FailureOutcome outcome = upload.failAttempt(message, retry, props.volume().maxAttempts(), now);
        if (outcome == FailureOutcome.RETRY_SCHEDULED) {
            Instant due = now.plus(props.volume().backoffBefore(upload.getAttempt()));
            dispatcher.dispatch(upload, due);
            log.info("Upload {} ingest attempt {} failed ({}), attempt {} at {}", upload.getId(), upload.getAttempt() - 1,
                    message, upload.getAttempt(), due);
        } else {
            rawUploads.deleteAfterCommit(rawKey(upload));
            log.warn("Upload {} failed after ingest attempt {}: {}", upload.getId(), upload.getAttempt(), message);
        }
    }

    private record Volume(Payload payload, String volumeKey, String thumbnailKey) {
    }

    /** The payload must describe a 3D volume stored where the worker was told to write it. */
    private Volume readVolume(UploadSession upload, String payloadJson) {
        if (payloadJson == null) {
            throw new IllegalArgumentException("DONE without payload");
        }
        Payload p = json.readValue(payloadJson, Payload.class);
        requireTriple("dims", p.dims(), d -> d > 0);
        requireTriple("spacing", p.spacing(), s -> s > 0 && Double.isFinite(s));
        return new Volume(p, ownKey(upload, p.volumeUri()), ownKey(upload, p.thumbnailUri()));
    }

    private String ownKey(UploadSession upload, String uri) {
        String key = storage.keyOf(uri);
        if (!key.startsWith(upload.volumePrefix())) {
            throw new IllegalArgumentException(uri + " is outside " + upload.volumePrefix());
        }
        return key;
    }

    private static <T> void requireTriple(String name, List<T> values, Predicate<T> valid) {
        if (values == null || values.size() != 3 || !values.stream().allMatch(v -> v != null && valid.test(v))) {
            throw new IllegalArgumentException(name + " must be three positive numbers: " + values);
        }
    }

    private static String rawKey(UploadSession upload) {
        return upload.getFiles().getFirst().getStorageKey();
    }

    /**
     * The worker could not parse the job message, so it does not know the attempt and reports 0. Re-sending the same
     * message cannot succeed, so the upload fails for good whatever its current attempt is.
     */
    private static boolean isRejectedJobMessage(IngestResult r) {
        return r.type() == IngestResult.Type.FAILED && r.attempt() == 0 && !r.retryable();
    }
}
