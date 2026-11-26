package com.medimg.dashboard.api;

import java.time.LocalDate;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.dashboard.application.DashboardDtos.DashboardDto;
import com.medimg.dashboard.application.DashboardService;
import com.medimg.shared.security.AccessPolicy;

import io.swagger.v3.oas.annotations.tags.Tag;

/** Aggregate figures for every role; nothing in it identifies a patient. */
@RestController
@RequestMapping("/api/v1/dashboard")
@Tag(name = "Dashboard")
@PreAuthorize(AccessPolicy.READ)
class DashboardController {

    private final DashboardService service;

    DashboardController(DashboardService service) {
        this.service = service;
    }

    /** {@code from} / {@code to}: ISO dates (YYYY-MM-DD), both included; 400 {@code /problems/invalid-date-range}. */
    @GetMapping
    DashboardDto dashboard(@RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
                           @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        return service.dashboard(from, to);
    }
}
