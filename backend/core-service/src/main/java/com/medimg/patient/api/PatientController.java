package com.medimg.patient.api;

import java.util.UUID;

import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.patient.application.PatientDto;
import com.medimg.patient.application.PatientService;
import com.medimg.patient.application.PatientService.CreatePatient;
import com.medimg.patient.application.PatientService.UpdatePatient;
import com.medimg.shared.security.AccessPolicy;
import com.medimg.shared.web.PageResponse;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/v1/patients")
@Tag(name = "Patients (cases)")
@PreAuthorize(AccessPolicy.READ)
class PatientController {

    record CreateRequest(
            @Size(max = 32) @Pattern(regexp = "^[A-Za-z0-9_-]*$", message = "letters, digits, - and _ only") String code,
            @BirthYear Short birthYear,
            @Pattern(regexp = "^[MFO]$", message = "must be M, F or O") String sex,
            @Size(max = 500) String note) {
    }

    record UpdateRequest(
            @BirthYear Short birthYear,
            @Pattern(regexp = "^[MFO]$", message = "must be M, F or O") String sex,
            @Size(max = 500) String note) {
    }

    private final PatientService service;

    PatientController(PatientService service) {
        this.service = service;
    }

    @GetMapping
    PageResponse<PatientDto> search(@RequestParam(required = false) String q,
                                    @RequestParam(defaultValue = "0") @Min(0) int page,
                                    @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        return service.search(q, PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "createdAt")));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize(AccessPolicy.WRITE)
    PatientDto create(@Valid @RequestBody CreateRequest req) {
        return service.create(new CreatePatient(req.code(), req.birthYear(), req.sex(), req.note()));
    }

    @GetMapping("/{id}")
    PatientDto get(@PathVariable UUID id) {
        return service.get(id);
    }

    @PutMapping("/{id}")
    @PreAuthorize(AccessPolicy.WRITE)
    PatientDto update(@PathVariable UUID id, @Valid @RequestBody UpdateRequest req) {
        return service.update(id, new UpdatePatient(req.birthYear(), req.sex(), req.note()));
    }

    @DeleteMapping("/{id}")
    @PreAuthorize(AccessPolicy.ADMIN)
    ResponseEntity<Void> delete(@PathVariable UUID id) {
        service.delete(id);
        return ResponseEntity.noContent().build();
    }
}
