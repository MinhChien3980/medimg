package com.medimg.prediction.api;

import java.util.List;
import java.util.UUID;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.prediction.application.ModelAdminService;
import com.medimg.prediction.application.ModelAdminService.AdminModelDto;
import com.medimg.shared.security.AccessPolicy;

import io.swagger.v3.oas.annotations.tags.Tag;

/** Model administration (ADMIN only). */
@RestController
@RequestMapping("/api/v1/admin/models")
@Tag(name = "Administration – models")
@PreAuthorize(AccessPolicy.ADMIN)
class ModelAdminController {

    private final ModelAdminService service;

    ModelAdminController(ModelAdminService service) {
        this.service = service;
    }

    /** Every model, whatever its status, with its usage. */
    @GetMapping
    List<AdminModelDto> list() {
        return service.list();
    }

    /** 409 {@code /problems/model-status} for a STAGING or RETIRED model. */
    @PostMapping("/{id}/disable")
    AdminModelDto disable(@PathVariable UUID id) {
        return service.disable(id);
    }

    @PostMapping("/{id}/enable")
    AdminModelDto enable(@PathVariable UUID id) {
        return service.enable(id);
    }
}
