package com.medimg.imaging.infrastructure;

import org.springframework.stereotype.Component;

import com.medimg.imaging.application.IngestDispatcher;
import com.medimg.shared.outbox.OutboxRoute;

/** Ingest dispatches go to {@code imaging.jobs}; the ingest worker owns its consumer group. */
@Component
class IngestJobsRoute implements OutboxRoute {

    static final String JOBS_STREAM = "imaging.jobs";

    @Override
    public String type() {
        return IngestDispatcher.MESSAGE_TYPE;
    }

    @Override
    public String stream() {
        return JOBS_STREAM;
    }
}
