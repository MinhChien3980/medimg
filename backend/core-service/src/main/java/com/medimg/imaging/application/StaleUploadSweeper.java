package com.medimg.imaging.application;

import java.time.Clock;
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
 * Processing runs in memory on the instance that accepted the upload. If that instance stops (restart, crash) the
 * upload would stay UPLOADED or PROCESSING forever; this sweep marks such uploads FAILED so the user can retry.
 */
@Component
public class StaleUploadSweeper {

    private static final Logger log = LoggerFactory.getLogger(StaleUploadSweeper.class);
    private static final List<UploadSession.Status> IN_PROGRESS =
            List.of(UploadSession.Status.UPLOADED, UploadSession.Status.PROCESSING);

    private final UploadSessionRepository uploads;
    private final ImagingProperties props;
    private final Clock clock;

    StaleUploadSweeper(UploadSessionRepository uploads, ImagingProperties props, Clock clock) {
        this.uploads = uploads;
        this.props = props;
        this.clock = clock;
    }

    /** Returns the number of uploads marked FAILED. */
    @Scheduled(fixedDelay = 60_000, initialDelay = 60_000)
    @Transactional
    public int failStaleUploads() {
        Instant now = clock.instant();
        List<UploadSession> stale = uploads.findByStatusInAndUpdatedAtBefore(IN_PROGRESS, now.minus(props.processingTimeout()));
        for (UploadSession upload : stale) {
            log.warn("Upload {} was {} for more than {}; marking it FAILED", upload.getId(), upload.getStatus(),
                    props.processingTimeout());
            upload.markFailed("Processing did not finish, please upload the image again", now);
        }
        return stale.size();
    }
}
