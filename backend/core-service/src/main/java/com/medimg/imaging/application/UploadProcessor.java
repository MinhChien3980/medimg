package com.medimg.imaging.application;

import java.time.Clock;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.imaging.application.ImageNormalizer.InvalidImageException;
import com.medimg.imaging.application.ImageNormalizer.Normalized;
import com.medimg.imaging.application.UploadService.UploadCompleted;
import com.medimg.imaging.domain.ImageFile;
import com.medimg.imaging.domain.Series;
import com.medimg.imaging.domain.Study;
import com.medimg.imaging.domain.UploadFile;
import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.infrastructure.ImageFileRepository;
import com.medimg.imaging.infrastructure.SeriesRepository;
import com.medimg.imaging.infrastructure.StudyRepository;
import com.medimg.imaging.infrastructure.UploadSessionRepository;
import com.medimg.shared.storage.ObjectStoragePort;

/** Background processing of a completed 2D image upload: validate → de-identify → normalise → Study/Series. */
@Component
class UploadProcessor {

    private static final Logger log = LoggerFactory.getLogger(UploadProcessor.class);

    private final UploadSessionRepository uploads;
    private final StudyRepository studies;
    private final SeriesRepository series;
    private final ImageFileRepository imageFiles;
    private final ObjectStoragePort storage;
    private final RawUploads rawUploads;
    private final ImagingProperties props;
    private final TransactionTemplate tx;
    private final Clock clock;

    UploadProcessor(UploadSessionRepository uploads, StudyRepository studies, SeriesRepository series,
                    ImageFileRepository imageFiles, ObjectStoragePort storage, RawUploads rawUploads,
                    ImagingProperties props, TransactionTemplate tx, Clock clock) {
        this.uploads = uploads;
        this.studies = studies;
        this.series = series;
        this.imageFiles = imageFiles;
        this.storage = storage;
        this.rawUploads = rawUploads;
        this.props = props;
        this.tx = tx;
        this.clock = clock;
    }

    @Async
    @TransactionalEventListener
    void on(UploadCompleted event) {
        process(event.uploadId());
    }

    /**
     * Every outcome ends in DONE or FAILED. An {@link Error} (e.g. {@link OutOfMemoryError}) is rethrown after the
     * upload is marked FAILED: the JVM may be unhealthy, so it is reported like any other fatal error instead of
     * being swallowed here.
     */
    void process(UUID uploadId) {
        UploadSession session = tx.execute(s -> {
            UploadSession u = uploads.findById(uploadId).orElseThrow();
            u.markProcessing(clock.instant());
            return u;
        });
        UploadFile file = session.getFiles().getFirst();
        try {
            byte[] original = storage.get(file.getStorageKey());
            Normalized img = ImageNormalizer.normalize2d(original, props.minImageDimension());

            Study study = new Study(session.getPatientId(), Study.InputType.IMAGE_2D, session.getModalityHint(),
                    session.getBodyPartHint(), session.getCreatedBy(), clock.instant());
            UUID seriesId = UUID.randomUUID();
            String prefix = study.getStoragePrefix() + "series/" + seriesId + "/";
            storage.put(prefix + "image.png", img.png(), "image/png");
            storage.put(prefix + "thumb.png", img.thumbnailPng(), "image/png");

            tx.executeWithoutResult(s -> {
                studies.save(study);
                series.save(new Series(seriesId, study.getId(), study.getModality(), 1, img.height(), img.width(),
                        prefix + "image.png", prefix + "thumb.png", clock.instant()));
                imageFiles.save(new ImageFile(seriesId, file.getName(), "image/png", img.png().length,
                        img.sha256Original(), prefix + "image.png", 1));
                uploads.findById(uploadId).orElseThrow().markDone(study.getId(), clock.instant());
            });
            rawUploads.delete(file.getStorageKey());
            log.info("Upload {} processed into study {} ({}x{})", uploadId, study.getId(), img.width(), img.height());
        } catch (InvalidImageException e) {
            fail(uploadId, e.getMessage());
            rawUploads.delete(file.getStorageKey());
        } catch (Throwable t) {
            log.error("Processing upload {} failed", uploadId, t);
            fail(uploadId, "Processing failed, please try again");
            if (t instanceof Error error) {
                throw error;
            }
        }
    }

    /** Best effort; if even this fails, {@link StaleUploadSweeper} marks the upload FAILED later. */
    private void fail(UUID uploadId, String message) {
        try {
            tx.executeWithoutResult(s -> uploads.findById(uploadId).orElseThrow().markFailed(message, clock.instant()));
        } catch (RuntimeException e) {
            log.error("Could not mark upload {} as failed", uploadId, e);
        }
    }
}
