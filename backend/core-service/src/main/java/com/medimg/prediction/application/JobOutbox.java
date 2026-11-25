package com.medimg.prediction.application;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.prediction.domain.AiModel;
import com.medimg.prediction.domain.PredictionJob;
import com.medimg.prediction.infrastructure.AiModelRepository;
import com.medimg.shared.outbox.Outbox;
import com.medimg.shared.storage.ObjectStoragePort;

/**
 * Dispatch of AI job attempts through the transactional outbox: the job message is stored in the caller's transaction,
 * together with the job state change, and published to {@code ai.jobs.gpu} or {@code ai.jobs.cpu} once it is due.
 */
@Component
public class JobOutbox {

    /** Outbox message type of a job dispatch. */
    public static final String MESSAGE_TYPE = "JOB_DISPATCH";

    private final Outbox outbox;
    private final AiModelRepository models;
    private final StudyService studies;
    private final ObjectStoragePort storage;

    JobOutbox(Outbox outbox, AiModelRepository models, StudyService studies, ObjectStoragePort storage) {
        this.outbox = outbox;
        this.models = models;
        this.studies = studies;
        this.storage = storage;
    }

    /**
     * Schedules the job's current attempt for publication at {@code availableAt}. Workers read the normalised series:
     * the PNG of a 2D study, the NIfTI volume of a volume study.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    void dispatch(PredictionJob job, Instant availableAt) {
        AiModel model = models.findById(job.getModelId()).orElseThrow();
        SeriesRef ref = studies.requireSeries(job.getStudyId(), job.getSeriesId());
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("jobId", job.getId().toString());
        fields.put("attempt", Integer.toString(job.getAttempt()));
        fields.put("modelCode", model.getCode());
        fields.put("modelVersion", model.getVersion());
        fields.put("task", model.getTask().name());
        fields.put("inputType", ref.normalizedType());
        fields.put("inputUri", ref.normalizedUri());
        fields.put("outputPrefix", storage.uri("predictions/" + job.getId() + "/" + job.getAttempt() + "/"));
        fields.put("params", job.getParams() == null ? "{}" : job.getParams());
        outbox.enqueue(MESSAGE_TYPE, job.getId(), fields, availableAt);
    }

    /** Drops the dispatch of a job that will not run any more, if it has not been published yet. */
    @Transactional(propagation = Propagation.MANDATORY)
    void discardPending(UUID jobId) {
        outbox.discardPending(MESSAGE_TYPE, jobId);
    }
}
