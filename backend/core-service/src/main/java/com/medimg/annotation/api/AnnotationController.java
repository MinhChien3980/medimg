package com.medimg.annotation.api;

import java.util.List;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.annotation.application.AnnotationDtos.AnnotationDto;
import com.medimg.annotation.application.AnnotationDtos.CreateAnnotation;
import com.medimg.annotation.application.AnnotationDtos.UpdateAnnotation;
import com.medimg.annotation.application.AnnotationService;
import com.medimg.shared.security.AccessPolicy;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Annotations")
@PreAuthorize(AccessPolicy.READ)
class AnnotationController {

    /**
     * {@code kind}: RECTANGLE, POLYGON, ARROW or LENGTH on a 2D image (pixels), RECTANGLE_ROI, ELLIPSE_ROI or LENGTH on
     * a volume (LPS mm). {@code measurement}: {@code lengthMm, lengthPx, areaMm2, areaPx2, meanHu, stdHu}.
     */
    record CreateRequest(@NotNull UUID seriesId, @NotBlank @Size(max = 20) String kind, @NotNull JsonNode geometry,
                         @Size(max = 100) String label, @Size(max = 1000) String note, JsonNode measurement) {
    }

    /** The kind of an annotation never changes; {@code version} is the version the change was made on. */
    record UpdateRequest(@NotNull JsonNode geometry, @Size(max = 100) String label, @Size(max = 1000) String note,
                         JsonNode measurement, @NotNull Long version) {
    }

    private final AnnotationService annotations;

    AnnotationController(AnnotationService annotations) {
        this.annotations = annotations;
    }

    @GetMapping("/studies/{studyId}/annotations")
    List<AnnotationDto> byStudy(@PathVariable UUID studyId) {
        return annotations.listByStudy(studyId);
    }

    @PostMapping("/studies/{studyId}/annotations")
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize(AccessPolicy.ANNOTATE)
    AnnotationDto create(@PathVariable UUID studyId, @Valid @RequestBody CreateRequest req) {
        return annotations.create(new CreateAnnotation(studyId, req.seriesId(), req.kind(), req.geometry(), req.label(),
                req.note(), req.measurement()));
    }

    @PutMapping("/annotations/{id}")
    @PreAuthorize(AccessPolicy.ANNOTATE)
    AnnotationDto update(@PathVariable UUID id, @Valid @RequestBody UpdateRequest req) {
        return annotations.update(id, new UpdateAnnotation(req.geometry(), req.label(), req.note(), req.measurement(),
                req.version()));
    }

    @DeleteMapping("/annotations/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize(AccessPolicy.ANNOTATE)
    void delete(@PathVariable UUID id) {
        annotations.delete(id);
    }
}
