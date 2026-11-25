package com.medimg.prediction.application;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.medimg.prediction.application.PredictionDtos.PredictionChanged;
import com.medimg.prediction.application.PredictionDtos.PredictionDto;
import com.medimg.prediction.domain.JobStatus;
import com.medimg.shared.web.ApiException;

/**
 * Server-Sent Events for job progress. Subscribers are kept in memory, so a client only receives the
 * {@link PredictionChanged} events of the instance it is connected to (the deployment runs a single instance).
 */
@Component
public class PredictionSseHub {

    private static final Logger log = LoggerFactory.getLogger(PredictionSseHub.class);

    record ProgressEvent(UUID jobId, String status, int progress) {
    }

    private final Map<UUID, Set<SseEmitter>> emitters = new ConcurrentHashMap<>();
    private final PredictionService predictions;
    private final PredictionProperties props;

    PredictionSseHub(PredictionService predictions, PredictionProperties props) {
        this.predictions = predictions;
        this.props = props;
    }

    public SseEmitter subscribe(UUID jobId) {
        PredictionDto current = predictions.get(jobId); // 404 for unknown jobs, before opening the stream
        SseEmitter emitter = new SseEmitter(props.sseTimeout().toMillis());
        Set<SseEmitter> set = emitters.computeIfAbsent(jobId, k -> ConcurrentHashMap.newKeySet());
        set.add(emitter);
        Runnable remove = () -> {
            set.remove(emitter);
            emitters.computeIfPresent(jobId, (k, v) -> v.isEmpty() ? null : v);
        };
        emitter.onCompletion(remove);
        emitter.onTimeout(remove);
        emitter.onError(e -> remove.run());
        sendState(emitter, current);
        return emitter;
    }

    @TransactionalEventListener(fallbackExecution = true)
    void on(PredictionChanged change) {
        Set<SseEmitter> set = emitters.get(change.jobId());
        if (set == null || set.isEmpty()) {
            return;
        }
        PredictionDto dto = null;
        if (JobStatus.valueOf(change.status()).isTerminal()) {
            try {
                dto = predictions.get(change.jobId());
            } catch (ApiException e) { // the case was deleted while a client was watching the job
                set.forEach(SseEmitter::complete);
                return;
            }
        }
        for (SseEmitter emitter : set) {
            if (dto != null) {
                sendState(emitter, dto);
            } else {
                send(emitter, "progress", new ProgressEvent(change.jobId(), change.status(), change.progress()));
            }
        }
    }

    @Scheduled(fixedDelayString = "${app.ai.sse-heartbeat}")
    void heartbeat() {
        emitters.values().forEach(set -> set.forEach(e -> {
            try {
                e.send(SseEmitter.event().comment("hb"));
            } catch (IOException | IllegalStateException ex) {
                e.completeWithError(ex);
            }
        }));
    }

    private void sendState(SseEmitter emitter, PredictionDto dto) {
        JobStatus status = JobStatus.valueOf(dto.status());
        if (status == JobStatus.DONE) {
            send(emitter, "done", dto);
            emitter.complete();
        } else if (status.isTerminal()) {
            send(emitter, "failed", dto);
            emitter.complete();
        } else {
            send(emitter, "progress", new ProgressEvent(dto.jobId(), dto.status(), dto.progress()));
        }
    }

    private void send(SseEmitter emitter, String name, Object data) {
        try {
            emitter.send(SseEmitter.event().name(name).data(data, MediaType.APPLICATION_JSON));
        } catch (IOException | IllegalStateException e) {
            log.debug("SSE client gone: {}", e.getMessage());
            emitter.completeWithError(e);
        }
    }
}
