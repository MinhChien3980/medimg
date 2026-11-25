package com.medimg.imaging.application;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.domain.UploadFile;
import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.infrastructure.UploadSessionRepository;

/**
 * Fails uploads that stopped making progress, so the user can upload again:
 * <ul>
 *   <li>a PNG/JPEG image is processed in memory on the instance that accepted it; if that instance stops (restart,
 *       crash) the upload would stay UPLOADED or PROCESSING forever;</li>
 *   <li>other files are processed by the ingest worker; with no news from it for the volume timeout (no worker
 *       running, worker died) the upload fails and a dispatch that was never published is dropped;</li>
 *   <li>a file uploaded in parts whose upload was never completed (tab closed, network lost) would keep its parts in
 *       the object storage forever: its multipart upload is aborted.</li>
 * </ul>
 */
@Component
public class StaleUploadSweeper {

    private static final Logger log = LoggerFactory.getLogger(StaleUploadSweeper.class);
    private static final List<UploadSession.Status> IN_PROGRESS =
            List.of(UploadSession.Status.UPLOADED, UploadSession.Status.PROCESSING);

    private final UploadSessionRepository uploads;
    private final IngestDispatcher dispatcher;
    private final RawUploads rawUploads;
    private final ImagingProperties props;
    private final Clock clock;

    StaleUploadSweeper(UploadSessionRepository uploads, IngestDispatcher dispatcher, RawUploads rawUploads,
                       ImagingProperties props, Clock clock) {
        this.uploads = uploads;
        this.dispatcher = dispatcher;
        this.rawUploads = rawUploads;
        this.props = props;
        this.clock = clock;
    }

    /** Returns the number of uploads marked FAILED. */
    @Scheduled(fixedDelay = 60_000, initialDelay = 60_000)
    @Transactional
    public int failStaleUploads() {
        Instant now = clock.instant();
        Duration shortest = min(props.processingTimeout(), props.volume().processingTimeout());
        int failed = 0;
        for (UploadSession upload : uploads.findByStatusInAndUpdatedAtBefore(IN_PROGRESS, now.minus(shortest))) {
            Duration timeout = upload.isIngested() ? props.volume().processingTimeout() : props.processingTimeout();
            if (!upload.getUpdatedAt().isBefore(now.minus(timeout))) {
                continue;
            }
            log.warn("Upload {} was {} for more than {}; marking it FAILED", upload.getId(), upload.getStatus(), timeout);
            if (upload.isIngested()) {
                upload.markFailed("Processing did not finish, please upload the file again", now);
                dispatcher.discardPending(upload.getId());
            } else {
                upload.markFailed("Processing did not finish, please upload the image again", now);
            }
            failed++;
        }
        return failed;
    }

    /** Returns the number of multipart uploads aborted. */
    @Scheduled(fixedDelay = 60_000, initialDelay = 60_000)
    @Transactional
    public int abortAbandonedMultipartUploads() {
        Instant now = clock.instant();
        Duration timeout = props.multipart().abandonAfter();
        List<UploadSession> abandoned = uploads.findMultipartByStatusAndCreatedAtBefore(UploadSession.Status.INIT,
                now.minus(timeout));
        for (UploadSession upload : abandoned) {
            log.warn("Upload {} in parts was not completed within {}; aborting it", upload.getId(), timeout);
            upload.markFailed("The upload was not completed in time, please upload the file again", now);
            UploadFile file = upload.getFiles().getFirst();
            rawUploads.abortMultipartAfterCommit(file.getStorageKey(), file.getMultipartUploadId());
        }
        return abandoned.size();
    }

    private static Duration min(Duration a, Duration b) {
        return a.compareTo(b) <= 0 ? a : b;
    }
}
