package com.medimg.prediction.application;

import java.net.URI;
import java.time.Clock;
import java.time.Instant;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.prediction.application.PredictionDtos.ArtifactsDto;
import com.medimg.prediction.application.PredictionDtos.CreatePrediction;
import com.medimg.prediction.application.PredictionDtos.CreatedJob;
import com.medimg.prediction.application.PredictionDtos.FindingDto;
import com.medimg.prediction.application.PredictionDtos.JobSummary;
import com.medimg.prediction.application.PredictionDtos.MeshDto;
import com.medimg.prediction.application.PredictionDtos.ModelDto;
import com.medimg.prediction.application.PredictionDtos.ModelRef;
import com.medimg.prediction.application.PredictionDtos.PredictionChanged;
import com.medimg.prediction.application.PredictionDtos.PredictionDto;
import com.medimg.prediction.domain.AiModel;
import com.medimg.prediction.domain.Finding;
import com.medimg.prediction.domain.JobStatus;
import com.medimg.prediction.domain.PredictionJob;
import com.medimg.prediction.domain.PredictionResult;
import com.medimg.prediction.infrastructure.AiModelRepository;
import com.medimg.prediction.infrastructure.FindingRepository;
import com.medimg.prediction.infrastructure.PredictionJobRepository;
import com.medimg.prediction.infrastructure.PredictionResultRepository;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.web.ApiException;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

@Service
public class PredictionService {

    private static final Logger log = LoggerFactory.getLogger(PredictionService.class);
    private static final TypeReference<List<String>> STRING_LIST = new TypeReference<>() { };
    private static final TypeReference<Map<String, String>> STRING_MAP = new TypeReference<>() { };
    private static final TypeReference<Map<String, Object>> OBJECT_MAP = new TypeReference<>() { };
    private static final TypeReference<List<MeshArtifact>> MESH_LIST = new TypeReference<>() { };

    private final PredictionJobRepository jobs;
    private final PredictionResultRepository results;
    private final FindingRepository findings;
    private final FindingMapper findingMapper;
    private final AiModelRepository models;
    private final StudyService studies;
    private final JobOutbox outbox;
    private final JobQueuePort queue;
    private final ObjectStoragePort storage;
    private final ObjectMapper json;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;
    private final Clock clock;

    PredictionService(PredictionJobRepository jobs, PredictionResultRepository results, FindingRepository findings,
                      FindingMapper findingMapper, AiModelRepository models, StudyService studies, JobOutbox outbox,
                      JobQueuePort queue, ObjectStoragePort storage, ObjectMapper json, ApplicationEventPublisher events,
                      TransactionTemplate tx, Clock clock) {
        this.jobs = jobs;
        this.results = results;
        this.findings = findings;
        this.findingMapper = findingMapper;
        this.models = models;
        this.studies = studies;
        this.outbox = outbox;
        this.queue = queue;
        this.storage = storage;
        this.json = json;
        this.events = events;
        this.tx = tx;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<ModelDto> models(String inputType) {
        return models.findByStatusOrderByCodeAsc(AiModel.Status.ACTIVE).stream()
                .filter(m -> inputType == null || inputType.isBlank() || m.accepts(inputType))
                .map(m -> new ModelDto(m.getId(), m.getCode(), m.getVersion(), m.getName(), m.getTask().name(),
                        m.getLabels() == null ? List.of() : json.readValue(m.getLabels(), STRING_LIST)))
                .toList();
    }

    /**
     * With an {@code Idempotency-Key} a repeated request returns the job created by the first one, also when both
     * arrive at the same time: the loser of the race hits the unique key and returns the winner's job.
     */
    @Audited(action = "PREDICTION_CREATE", resource = "PREDICTION")
    public CreatedJob create(CreatePrediction cmd) {
        UUID user = CurrentUser.id();
        try {
            return tx.execute(s -> createOrReplay(cmd, user));
        } catch (DataIntegrityViolationException e) {
            if (cmd.idempotencyKey() == null) {
                throw e;
            }
            return tx.execute(s -> jobs.findByRequestedByAndIdempotencyKey(user, cmd.idempotencyKey()).map(this::created)
                    .orElseThrow(() -> e));
        }
    }

    private CreatedJob createOrReplay(CreatePrediction cmd, UUID user) {
        if (cmd.idempotencyKey() != null) {
            var existing = jobs.findByRequestedByAndIdempotencyKey(user, cmd.idempotencyKey());
            if (existing.isPresent()) {
                return created(existing.get());
            }
        }
        SeriesRef ref = studies.requireSeries(cmd.studyId(), cmd.seriesId());
        AiModel model = models.findFirstByCodeAndStatusOrderByCreatedAtDesc(cmd.modelCode(), AiModel.Status.ACTIVE)
                .orElseThrow(() -> models.existsByCodeAndStatus(cmd.modelCode(), AiModel.Status.DISABLED)
                        ? modelDisabled(cmd.modelCode())
                        : ApiException.badRequest("Unknown or inactive model " + cmd.modelCode()));
        if (!model.accepts(ref.inputType())) {
            throw ApiException.unprocessable("Model " + model.getCode() + " does not accept " + ref.inputType() + " input");
        }
        if (!model.supportsModality(ref.modality())) {
            throw ApiException.unprocessable("Model " + model.getCode() + " is for " + model.getModality()
                    + " images, the series is " + (ref.modality() == null ? "of unknown modality" : ref.modality()));
        }
        PredictionJob job = new PredictionJob(ref.studyId(), ref.seriesId(), model.getId(),
                json.writeValueAsString(validatedParams(cmd.params())), cmd.idempotencyKey(), user, clock.instant());
        jobs.saveAndFlush(job);
        outbox.dispatch(job, job.getQueuedAt());
        events.publishEvent(new PredictionChanged(job.getId(), job.getStatus().name(), 0));
        return created(job);
    }

    @Transactional(readOnly = true)
    public PredictionDto get(UUID jobId) {
        PredictionJob job = require(jobId);
        return toDtos(List.of(job)).getFirst();
    }

    @Transactional(readOnly = true)
    public List<PredictionDto> listByStudy(UUID studyId) {
        studies.requireExists(studyId);
        return toDtos(jobs.findByStudyIdOrderByQueuedAtDesc(studyId));
    }

    /** The models (code and version) of the study's DONE jobs, e.g. for the technique section of a report. */
    @Transactional(readOnly = true)
    public List<ModelRef> modelsOfDoneJobs(UUID studyId) {
        List<UUID> modelIds = jobs.findByStudyIdOrderByQueuedAtDesc(studyId).stream()
                .filter(j -> j.getStatus() == JobStatus.DONE).map(PredictionJob::getModelId).distinct().toList();
        return models.findAllById(modelIds).stream()
                .map(m -> new ModelRef(m.getCode(), m.getVersion()))
                .sorted(Comparator.comparing(ModelRef::code).thenComparing(ModelRef::version))
                .toList();
    }

    /** The most recently queued job of each of the given studies that has one. */
    @Transactional(readOnly = true)
    public Map<UUID, JobSummary> latestByStudy(Collection<UUID> studyIds) {
        if (studyIds.isEmpty()) {
            return Map.of();
        }
        List<PredictionJob> latest = jobs.findLatestByStudyIds(studyIds);
        Map<UUID, String> codeByModel = models.findAllById(latest.stream().map(PredictionJob::getModelId).distinct().toList())
                .stream().collect(Collectors.toMap(AiModel::getId, AiModel::getCode));
        return latest.stream().collect(Collectors.toMap(PredictionJob::getStudyId,
                j -> new JobSummary(j.getId(), codeByModel.get(j.getModelId()), j.getStatus().name()),
                (a, b) -> a)); // two jobs queued at the same instant: either is the latest
    }

    @Transactional
    @Audited(action = "PREDICTION_RETRY", resource = "PREDICTION")
    public PredictionDto retry(UUID jobId) {
        PredictionJob job = require(jobId);
        models.findById(job.getModelId()).filter(m -> m.getStatus() == AiModel.Status.DISABLED).ifPresent(m -> {
            throw modelDisabled(m.getCode());
        });
        try {
            job.manualRetry(clock.instant());
        } catch (IllegalStateException e) {
            throw ApiException.conflict(e.getMessage());
        }
        outbox.dispatch(job, job.getQueuedAt());
        events.publishEvent(new PredictionChanged(job.getId(), job.getStatus().name(), 0));
        return toDtos(List.of(job)).getFirst();
    }

    @Transactional
    @Audited(action = "PREDICTION_CANCEL", resource = "PREDICTION")
    public PredictionDto cancel(UUID jobId) {
        PredictionJob job = require(jobId);
        try {
            job.cancel(clock.instant());
        } catch (IllegalStateException e) {
            throw ApiException.conflict(e.getMessage());
        }
        outbox.discardPending(jobId);
        markCancelledAfterCommit(jobId);
        events.publishEvent(new PredictionChanged(job.getId(), job.getStatus().name(), job.getProgress()));
        return toDtos(List.of(job)).getFirst();
    }

    /**
     * The flag covers a message that was already published. It is best effort: if it cannot be set, a worker may still
     * run the job, and its results are ignored because the job is cancelled.
     */
    private void markCancelledAfterCommit(UUID jobId) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                try {
                    queue.markCancelled(jobId);
                } catch (RuntimeException e) {
                    log.warn("Could not set the cancel flag of job {}", jobId, e);
                }
            }
        });
    }

    /** A disabled model takes no new job and no manual retry; jobs already queued or running go on. */
    private static ApiException modelDisabled(String code) {
        return ApiException.unprocessable("Model " + code + " is disabled").type("model-disabled");
    }

    private CreatedJob created(PredictionJob job) {
        long position = job.getStatus() == JobStatus.QUEUED
                ? jobs.countQueuedUpTo(JobStatus.QUEUED, job.getQueuedAt()) : 0;
        return new CreatedJob(job.getId(), job.getStatus().name(), Math.max(position, job.getStatus() == JobStatus.QUEUED ? 1 : 0));
    }

    /** Jobs of a study that is no longer visible (its case was deleted) are not found either. */
    private PredictionJob require(UUID jobId) {
        return jobs.findById(jobId)
                .filter(job -> studies.exists(job.getStudyId()))
                .orElseThrow(() -> ApiException.notFound("Prediction", jobId));
    }

    private static Map<String, Object> validatedParams(Map<String, Object> params) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (params == null) {
            return out;
        }
        Object threshold = params.get("threshold");
        if (threshold != null) {
            if (!(threshold instanceof Number n) || n.doubleValue() < 0 || n.doubleValue() > 1) {
                throw ApiException.badRequest("params.threshold must be a number between 0 and 1");
            }
            out.put("threshold", n.doubleValue());
        }
        return out;
    }

    private List<PredictionDto> toDtos(List<PredictionJob> list) {
        if (list.isEmpty()) {
            return List.of();
        }
        Collection<UUID> jobIds = list.stream().map(PredictionJob::getId).toList();
        Map<UUID, AiModel> modelById = models.findAllById(list.stream().map(PredictionJob::getModelId).distinct().toList())
                .stream().collect(Collectors.toMap(AiModel::getId, Function.identity()));
        Map<UUID, PredictionResult> resultByJob = results.findByJobIdIn(jobIds).stream()
                .collect(Collectors.toMap(PredictionResult::getJobId, Function.identity()));
        List<Finding> allFindings = resultByJob.isEmpty() ? List.of()
                : findings.findByResultIds(resultByJob.values().stream().map(PredictionResult::getId).toList());
        Map<UUID, List<Finding>> findingsByResult = allFindings.stream().collect(Collectors.groupingBy(Finding::getResultId));
        Function<Finding, FindingDto> toFindingDto = findingMapper.converterFor(allFindings);

        return list.stream().map(job -> {
            AiModel model = modelById.get(job.getModelId());
            PredictionResult result = job.getStatus() == JobStatus.DONE ? resultByJob.get(job.getId()) : null;
            List<FindingDto> fs = result == null ? List.of()
                    : findingsByResult.getOrDefault(result.getId(), List.of()).stream().map(toFindingDto).toList();
            Instant finished = job.getFinishedAt();
            return new PredictionDto(job.getId(), job.getStudyId(), job.getSeriesId(), job.getStatus().name(),
                    job.getProgress(), job.getAttempt(),
                    model == null ? null : new ModelRef(model.getCode(), model.getVersion()),
                    job.getParams() == null ? Map.of() : json.readValue(job.getParams(), OBJECT_MAP),
                    result == null ? null : result.getInferenceMs(), job.getErrorMessage(), job.getQueuedAt(), finished,
                    fs, artifacts(result));
        }).toList();
    }

    /** Presigned URLs of the result's files. */
    private ArtifactsDto artifacts(PredictionResult result) {
        Map<String, URI> heatmaps = new LinkedHashMap<>();
        if (result == null) {
            return new ArtifactsDto(heatmaps, null, List.of());
        }
        if (result.getHeatmaps() != null) {
            json.readValue(result.getHeatmaps(), STRING_MAP).forEach((label, key) -> heatmaps.put(label, url(key)));
        }
        List<MeshArtifact> stored = result.getMeshes() == null ? List.of() : json.readValue(result.getMeshes(), MESH_LIST);
        List<MeshDto> meshes = stored.stream()
                .map(m -> new MeshDto(m.label(), m.color(), url(m.key()), m.triangles(), m.volumeMl(), m.centroid()))
                .toList();
        return new ArtifactsDto(heatmaps, result.getSegmentationKey() == null ? null : url(result.getSegmentationKey()),
                meshes);
    }

    private URI url(String key) {
        return storage.presignGet(key).url();
    }
}
