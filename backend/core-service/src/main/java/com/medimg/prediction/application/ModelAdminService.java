package com.medimg.prediction.application;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.prediction.domain.AiModel;
import com.medimg.prediction.infrastructure.AiModelRepository;
import com.medimg.prediction.infrastructure.ModelUsageQueries;
import com.medimg.prediction.infrastructure.ModelUsageQueries.ModelUsage;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.audit.AuditEvents;
import com.medimg.shared.web.ApiException;

/**
 * Model administration: every model with its usage, and enabling / disabling. A DISABLED model is not listed by
 * {@code GET /models} and takes no new job or manual retry (422); jobs already queued or running are not affected,
 * automatic retries included. Changes are audited as MODEL_ENABLED / MODEL_DISABLED.
 */
@Service
public class ModelAdminService {

    /**
     * {@code stats} covers all jobs of the model, also those of deleted cases (the model did run them); the times are
     * those of DONE jobs, {@code null} while there is none.
     */
    public record AdminModelDto(UUID id, String code, String version, String name, String task, List<String> inputTypes,
                                String modality, String bodyPart, String status, StatsDto stats) {
    }

    public record StatsDto(long jobs, long done, long failed, Long avgInferenceMs, Long p95InferenceMs,
                           Instant lastUsedAt) {
    }

    private final AiModelRepository models;
    private final ModelUsageQueries usage;
    private final ApplicationEventPublisher events;

    ModelAdminService(AiModelRepository models, ModelUsageQueries usage, ApplicationEventPublisher events) {
        this.models = models;
        this.usage = usage;
        this.events = events;
    }

    @Transactional(readOnly = true)
    public List<AdminModelDto> list() {
        Map<UUID, ModelUsage> byModel = usage.usageByModel();
        return models.findAllByOrderByCodeAscVersionAsc().stream()
                .map(m -> toDto(m, byModel.getOrDefault(m.getId(), ModelUsage.NONE)))
                .toList();
    }

    @Transactional
    public AdminModelDto disable(UUID id) {
        return change(id, "MODEL_DISABLED", AiModel::disable);
    }

    @Transactional
    public AdminModelDto enable(UUID id) {
        return change(id, "MODEL_ENABLED", AiModel::enable);
    }

    private interface Change {
        boolean apply(AiModel model);
    }

    /** Disabling a disabled model (or enabling an active one) changes nothing; a STAGING or RETIRED model is a 409. */
    private AdminModelDto change(UUID id, String action, Change change) {
        AiModel model = models.findById(id).orElseThrow(() -> ApiException.notFound("Model", id));
        boolean changed;
        try {
            changed = change.apply(model);
        } catch (IllegalStateException e) {
            throw ApiException.conflict(e.getMessage()).type("model-status");
        }
        if (changed) {
            models.saveAndFlush(model);
            events.publishEvent(AuditEvents.current(action, "MODEL", id, Outcome.SUCCESS,
                    Map.of("code", model.getCode(), "version", model.getVersion())));
        }
        return toDto(model, usage.usageByModel().getOrDefault(id, ModelUsage.NONE));
    }

    private static AdminModelDto toDto(AiModel m, ModelUsage u) {
        return new AdminModelDto(m.getId(), m.getCode(), m.getVersion(), m.getName(), m.getTask().name(),
                Arrays.stream(m.getInputTypes().split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList(),
                m.getModality(), m.getBodyPart(), m.getStatus().name(),
                new StatsDto(u.jobs(), u.done(), u.failed(), round(u.avgInferenceMs()), round(u.p95InferenceMs()),
                        u.lastUsedAt() == null ? null : u.lastUsedAt().toInstant()));
    }

    private static Long round(Double value) {
        return value == null ? null : Math.round(value);
    }
}
