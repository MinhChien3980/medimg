package com.medimg.prediction.api;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.medimg.prediction.application.PredictionDtos.CreatePrediction;
import com.medimg.prediction.application.PredictionDtos.CreatedJob;
import com.medimg.prediction.application.PredictionDtos.ModelDto;
import com.medimg.prediction.application.PredictionDtos.PredictionDto;
import com.medimg.prediction.application.PredictionService;
import com.medimg.prediction.application.PredictionSseHub;
import com.medimg.shared.security.AccessPolicy;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/v1")
@Tag(name = "AI predictions")
@PreAuthorize(AccessPolicy.READ)
class PredictionController {

    record CreateRequest(@NotNull UUID studyId, @NotNull UUID seriesId, @NotBlank @Size(max = 50) String modelCode,
                         Map<String, Object> params) {
    }

    private final PredictionService predictions;
    private final PredictionSseHub sse;

    PredictionController(PredictionService predictions, PredictionSseHub sse) {
        this.predictions = predictions;
        this.sse = sse;
    }

    @GetMapping("/models")
    List<ModelDto> models(@RequestParam(required = false) String inputType) {
        return predictions.models(inputType);
    }

    @PostMapping("/predictions")
    @ResponseStatus(HttpStatus.ACCEPTED)
    @PreAuthorize(AccessPolicy.WRITE)
    CreatedJob create(@Valid @RequestBody CreateRequest req,
                      @RequestHeader(name = "Idempotency-Key", required = false) @Size(max = 64) String idempotencyKey) {
        return predictions.create(new CreatePrediction(req.studyId(), req.seriesId(), req.modelCode(), req.params(),
                idempotencyKey == null || idempotencyKey.isBlank() ? null : idempotencyKey.trim()));
    }

    @GetMapping("/predictions/{id}")
    PredictionDto get(@PathVariable UUID id) {
        return predictions.get(id);
    }

    @GetMapping("/studies/{studyId}/predictions")
    List<PredictionDto> byStudy(@PathVariable UUID studyId) {
        return predictions.listByStudy(studyId);
    }

    @PostMapping("/predictions/{id}/retry")
    @PreAuthorize(AccessPolicy.WRITE)
    PredictionDto retry(@PathVariable UUID id) {
        return predictions.retry(id);
    }

    @PostMapping("/predictions/{id}/cancel")
    @PreAuthorize(AccessPolicy.WRITE)
    PredictionDto cancel(@PathVariable UUID id) {
        return predictions.cancel(id);
    }

    @GetMapping(path = "/predictions/{id}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    SseEmitter events(@PathVariable UUID id, HttpServletResponse response) {
        response.setHeader("X-Accel-Buffering", "no"); // tells the Nginx reverse proxy not to buffer the stream
        response.setHeader("Cache-Control", "no-cache, no-transform");
        return sse.subscribe(id);
    }
}
