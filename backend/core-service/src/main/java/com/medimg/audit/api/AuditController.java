package com.medimg.audit.api;

import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.UUID;

import org.springframework.http.HttpHeaders;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.audit.application.AuditQueryService;
import com.medimg.audit.application.AuditQueryService.AuditEntryDto;
import com.medimg.audit.domain.AuditFilter;
import com.medimg.audit.domain.AuditRange;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.security.AccessPolicy;
import com.medimg.shared.web.PageResponse;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/**
 * The audit log (ADMIN only). {@code from} / {@code to}: a date ({@code YYYY-MM-DD}, whole days in the configured
 * zone) or an ISO-8601 date-time with offset; {@code to} excluded for a date-time, included for a date. Default: the
 * last 7 days; at most 93 days.
 */
@RestController
@RequestMapping("/api/v1/admin/audit")
@Tag(name = "Administration – audit log")
@PreAuthorize(AccessPolicy.ADMIN)
class AuditController {

    private static final DateTimeFormatter FILE_STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmm'Z'").withZone(ZoneOffset.UTC);

    private final AuditQueryService service;

    AuditController(AuditQueryService service) {
        this.service = service;
    }

    /** Newest first; {@code size} at most 200. */
    @GetMapping
    PageResponse<AuditEntryDto> search(@RequestParam(required = false) UUID userId,
                                       @RequestParam(required = false) @Size(max = 100) String username,
                                       @RequestParam(required = false) @Size(max = 50) String action,
                                       @RequestParam(required = false) @Size(max = 50) String entityType,
                                       @RequestParam(required = false) @Size(max = 64) String entityId,
                                       @RequestParam(required = false) Outcome outcome,
                                       @RequestParam(required = false) String from,
                                       @RequestParam(required = false) String to,
                                       @RequestParam(defaultValue = "0") @Min(0) int page,
                                       @RequestParam(defaultValue = "50") @Min(1) @Max(AuditQueryService.MAX_PAGE_SIZE) int size) {
        return service.search(filter(userId, username, action, entityType, entityId, outcome), service.range(from, to),
                page, size);
    }

    /** The actions recorded in the range, for a filter drop-down. */
    @GetMapping("/actions")
    List<String> actions(@RequestParam(required = false) String from, @RequestParam(required = false) String to) {
        return service.actions(service.range(from, to));
    }

    /**
     * The entries matching the same filters as CSV (UTF-8 with BOM), streamed; 422 {@code /problems/export-too-large}
     * above 100 000 rows.
     */
    @GetMapping("/export.csv")
    void export(@RequestParam(required = false) UUID userId,
                @RequestParam(required = false) @Size(max = 100) String username,
                @RequestParam(required = false) @Size(max = 50) String action,
                @RequestParam(required = false) @Size(max = 50) String entityType,
                @RequestParam(required = false) @Size(max = 64) String entityId,
                @RequestParam(required = false) Outcome outcome,
                @RequestParam(required = false) String from,
                @RequestParam(required = false) String to,
                HttpServletResponse response) {
        AuditRange range = service.range(from, to);
        service.exportCsv(filter(userId, username, action, entityType, entityId, outcome), range, r -> {
            response.setContentType("text/csv;charset=UTF-8");
            response.setHeader(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"audit-log-"
                    + FILE_STAMP.format(r.from()) + "-" + FILE_STAMP.format(r.to()) + ".csv\"");
            return response.getOutputStream();
        });
    }

    private static AuditFilter filter(UUID userId, String username, String action, String entityType, String entityId,
                                      Outcome outcome) {
        return new AuditFilter(userId, username, action, entityType, entityId, outcome == null ? null : outcome.name());
    }
}
