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

import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.infrastructure.UploadSessionRepository;

/**
 * Fails uploads that stopped making progress, so the user can upload again:
 * <ul>
 *   <li>a 2D image is processed in memory on the instance that accepted it; if that instance stops (restart, crash)
 *       the upload would stay UPLOADED or PROCESSING forever;</li>
 *   <li>a volume is processed by the ingest worker; with no news from it for the volume timeout (no worker running,
 *       worker died) the upload fails and a dispatch that was never published is dropped.</li>
 * </ul>
 */
@Component
public class StaleUploadSweeper {

    private static final Logger log = LoggerFactory.getLogger(StaleUploadSweeper.class);
    private static final List<UploadSession.Status> IN_PROGRESS =
            List.of(UploadSession.Status.UPLOADED, UploadSession.Status.PROCESSING);

    private final UploadSessionRepository uploads;
    private final IngestDispatcher dispatcher;
    private final ImagingProperties props;
    private final Clock clock;

    StaleUploadSweeper(UploadSessionRepository uploads, IngestDispatcher dispatcher, ImagingProperties props, Clock clock) {
        this.uploads = uploads;
        this.dispatcher = dispatcher;
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
            Duration timeout = upload.isVolume() ? props.volume().processingTimeout() : props.processingTimeout();
            if (!upload.getUpdatedAt().isBefore(now.minus(timeout))) {
                continue;
            }
            log.warn("Upload {} was {} for more than {}; marking it FAILED", upload.getId(), upload.getStatus(), timeout);
            if (upload.isVolume()) {
                upload.markFailed("Processing did not finish, please upload the volume again", now);
                dispatcher.discardPending(upload.getId());
            } else {
                upload.markFailed("Processing did not finish, please upload the image again", now);
            }
            failed++;
        }
        return failed;
    }

    private static Duration min(Duration a, Duration b) {
        return a.compareTo(b) <= 0 ? a : b;
    }
}
