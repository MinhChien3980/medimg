package com.medimg.imaging.api;

import java.util.List;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.imaging.application.ImagingDtos.FileSpec;
import com.medimg.imaging.application.ImagingDtos.InitUpload;
import com.medimg.imaging.application.ImagingDtos.InitUploadResponse;
import com.medimg.imaging.application.ImagingDtos.StudyDto;
import com.medimg.imaging.application.ImagingDtos.UploadDto;
import com.medimg.imaging.application.StudyService;
import com.medimg.imaging.application.UploadService;
import com.medimg.shared.security.AccessPolicy;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Imaging")
@PreAuthorize(AccessPolicy.READ)
class ImagingController {

    record FileRequest(@NotBlank @Size(max = 255) String name, @Positive long size, @NotBlank @Size(max = 100) String contentType) {
    }

    /** One file per upload (a single 2D image). */
    record InitRequest(@NotNull UUID patientId, @NotNull @Size(min = 1, max = 1) List<@Valid FileRequest> files,
                       @Size(max = 10) String modalityHint, @Size(max = 30) String bodyPartHint) {
    }

    private final UploadService uploads;
    private final StudyService studies;

    ImagingController(UploadService uploads, StudyService studies) {
        this.uploads = uploads;
        this.studies = studies;
    }

    @PostMapping("/uploads/init")
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize(AccessPolicy.WRITE)
    InitUploadResponse init(@Valid @RequestBody InitRequest req) {
        return uploads.init(new InitUpload(req.patientId(),
                req.files().stream().map(f -> new FileSpec(f.name(), f.size(), f.contentType())).toList(),
                req.modalityHint(), req.bodyPartHint()));
    }

    @PostMapping("/uploads/{id}/complete")
    @ResponseStatus(HttpStatus.ACCEPTED)
    @PreAuthorize(AccessPolicy.WRITE)
    UploadDto complete(@PathVariable UUID id) {
        return uploads.complete(id);
    }

    @GetMapping("/uploads/{id}")
    @PreAuthorize(AccessPolicy.WRITE)
    UploadDto upload(@PathVariable UUID id) {
        return uploads.get(id);
    }

    @GetMapping("/studies/{id}")
    StudyDto study(@PathVariable UUID id) {
        return studies.get(id);
    }

    @GetMapping("/patients/{patientId}/studies")
    List<StudyDto> studiesOfPatient(@PathVariable UUID patientId) {
        return studies.listByPatient(patientId);
    }
}
