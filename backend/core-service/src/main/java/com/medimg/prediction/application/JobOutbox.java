package com.medimg.prediction.application;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.prediction.application.JobQueuePort.JobMessage;
import com.medimg.prediction.domain.AiModel;
import com.medimg.prediction.domain.PredictionJob;
import com.medimg.prediction.infrastructure.AiModelRepository;
import com.medimg.prediction.infrastructure.OutboxMessage;
import com.medimg.prediction.infrastructure.OutboxMessageRepository;
import com.medimg.shared.storage.ObjectStoragePort;

import tools.jackson.databind.ObjectMapper;

/**
 * Write side of the transactional outbox. Dispatching a job stores its stream message as an outbox row in the caller's
 * transaction, together with the job state change; the relay publishes it once it is due. So a job is never committed
 * without its message, and a rolled-back job is never published.
 */
@Component
class JobOutbox {

    private final OutboxMessageRepository messages;
    private final AiModelRepository models;
    private final StudyService studies;
    private final ObjectStoragePort storage;
    private final ObjectMapper json;
    private final Clock clock;

    JobOutbox(OutboxMessageRepository messages, AiModelRepository models, StudyService studies, ObjectStoragePort storage,
              ObjectMapper json, Clock clock) {
        this.messages = messages;
        this.models = models;
        this.studies = studies;
        this.storage = storage;
        this.json = json;
        this.clock = clock;
    }

    /** Schedules the job's current attempt for publication at {@code availableAt}. */
    @Transactional(propagation = Propagation.MANDATORY)
    void dispatch(PredictionJob job, Instant availableAt) {
        AiModel model = models.findById(job.getModelId()).orElseThrow();
        SeriesRef ref = studies.requireSeries(job.getStudyId(), job.getSeriesId());
        JobMessage message = new JobMessage(job.getId(), job.getAttempt(), model.getCode(), model.getVersion(),
                model.getTask().name(), ref.inputType(), ref.imageUri(),
                storage.uri("predictions/" + job.getId() + "/" + job.getAttempt() + "/"),
                job.getParams() == null ? "{}" : job.getParams());
        messages.save(OutboxMessage.jobDispatch(job.getId(), json.writeValueAsString(message), availableAt, clock.instant()));
    }

    /** Drops the dispatch of a job that will not run any more, if it has not been published yet. */
    @Transactional(propagation = Propagation.MANDATORY)
    void discardPending(UUID jobId) {
        messages.deletePendingByJobId(jobId);
    }
}
