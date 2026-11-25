package com.medimg.prediction.api;

import java.util.List;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.prediction.application.FindingService;
import com.medimg.prediction.application.PredictionDtos.AddFinding;
import com.medimg.prediction.application.PredictionDtos.FindingDto;
import com.medimg.prediction.application.PredictionDtos.ReviewFinding;
import com.medimg.shared.security.AccessPolicy;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Findings")
@PreAuthorize(AccessPolicy.READ)
class FindingController {

    /** {@code status}: ACCEPTED, REJECTED or EDITED ({@code label} required); {@code version} as last read. */
    record ReviewRequest(@NotBlank String status, @Size(max = 100) String label, @Size(max = 1000) String note,
                         @NotNull Long version) {
    }

    record AddRequest(@NotNull UUID seriesId, @NotBlank @Size(max = 100) String label, @Size(max = 1000) String note,
                      UUID annotationId) {
    }

    private final FindingService findings;

    FindingController(FindingService findings) {
        this.findings = findings;
    }

    /** All findings of the study, or those with one of the given review statuses ({@code ?status=ACCEPTED&status=EDITED}). */
    @GetMapping("/studies/{studyId}/findings")
    List<FindingDto> byStudy(@PathVariable UUID studyId, @RequestParam(name = "status", required = false) List<String> statuses) {
        return findings.listByStudy(studyId, statuses);
    }

    @PostMapping("/studies/{studyId}/findings")
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize(AccessPolicy.REVIEW)
    FindingDto add(@PathVariable UUID studyId, @Valid @RequestBody AddRequest req) {
        return findings.add(new AddFinding(studyId, req.seriesId(), req.label(), req.note(), req.annotationId()));
    }

    @PatchMapping("/findings/{id}/review")
    @PreAuthorize(AccessPolicy.REVIEW)
    FindingDto review(@PathVariable UUID id, @Valid @RequestBody ReviewRequest req) {
        return findings.review(id, new ReviewFinding(req.status(), req.label(), req.note(), req.version()));
    }

    @DeleteMapping("/findings/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize(AccessPolicy.REVIEW)
    void delete(@PathVariable UUID id) {
        findings.delete(id);
    }
}
