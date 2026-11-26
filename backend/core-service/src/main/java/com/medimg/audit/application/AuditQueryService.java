package com.medimg.audit.application;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.UncheckedIOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.audit.domain.AuditFilter;
import com.medimg.audit.domain.AuditRange;
import com.medimg.audit.infrastructure.AuditLogQueries;
import com.medimg.audit.infrastructure.AuditLogQueries.AuditRow;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.audit.AuditEvents;
import com.medimg.shared.web.ApiException;
import com.medimg.shared.web.PageResponse;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The audit log for admins: a filtered, paged list, the actions of a range and a CSV export. Looking at the log is not
 * audited; an export is (AUDIT_EXPORTED, with its filters and row count), because it takes data out of the system.
 */
@Service
public class AuditQueryService {

    /** Rows an export may hold; a larger export is refused before anything is written (narrow the filters). */
    public static final int MAX_EXPORT_ROWS = 100_000;
    public static final int MAX_PAGE_SIZE = 200;

    /**
     * An audit entry; {@code entityType} / {@code entityId} name the resource acted on and {@code detail} is the JSON
     * object recorded with the action.
     */
    public record AuditEntryDto(long id, Instant occurredAt, UUID userId, String username, String action,
                                String entityType, String entityId, String outcome, String clientIp, String userAgent,
                                JsonNode detail) {
    }

    /** Where the CSV goes; opened only once the export is known to be allowed, so that a refusal is a plain 422. */
    public interface CsvTarget {
        OutputStream open(AuditRange range) throws IOException;
    }

    private final AuditLogQueries queries;
    private final ObjectMapper json;
    private final ApplicationEventPublisher events;
    private final ZoneId zone;
    private final Clock clock;

    AuditQueryService(AuditLogQueries queries, ObjectMapper json, ApplicationEventPublisher events,
                      AuditProperties props, Clock clock) {
        this.queries = queries;
        this.json = json;
        this.events = events;
        this.zone = props.zone();
        this.clock = clock;
    }

    /** See {@link AuditRange}: 400 {@code /problems/invalid-date-range} for a bad or too long range. */
    public AuditRange range(String from, String to) {
        try {
            return AuditRange.resolve(from, to, zone, clock.instant());
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(e.getMessage()).type("invalid-date-range");
        }
    }

    @Transactional(readOnly = true)
    public PageResponse<AuditEntryDto> search(AuditFilter filter, AuditRange range, int page, int size) {
        if (page < 0 || size < 1 || size > MAX_PAGE_SIZE) {
            throw ApiException.badRequest("page must be 0 or more and size between 1 and " + MAX_PAGE_SIZE);
        }
        long total = queries.count(filter, range);
        List<AuditEntryDto> content = queries.page(filter, range, page, size).stream().map(this::toDto).toList();
        return new PageResponse<>(content, page, size, total, (int) ((total + size - 1) / size));
    }

    @Transactional(readOnly = true)
    public List<String> actions(AuditRange range) {
        return queries.actions(range);
    }

    /**
     * Streams the matching entries as CSV (UTF-8 with BOM, newest first) without holding them in memory. More than
     * {@value #MAX_EXPORT_ROWS} rows is a 422 {@code /problems/export-too-large} before anything is written. Count and
     * rows come from one snapshot (repeatable read), so the export holds exactly the counted rows.
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public long exportCsv(AuditFilter filter, AuditRange range, CsvTarget target) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("filters", filter.asMap());
        detail.put("from", range.from().toString());
        detail.put("to", range.to().toString());
        long rows = queries.count(filter, range);
        detail.put("rowCount", rows);
        if (rows > MAX_EXPORT_ROWS) {
            detail.put("reason", "too_many_rows");
            audit(Outcome.FAILURE, detail);
            throw ApiException.unprocessable("The export would hold " + rows + " rows, at most " + MAX_EXPORT_ROWS
                    + " are allowed: narrow the filters or the time range").type("export-too-large")
                    .property("rowCount", rows).property("maxRows", MAX_EXPORT_ROWS);
        }
        long[] written = {0};
        try (Writer out = new BufferedWriter(new OutputStreamWriter(target.open(range), StandardCharsets.UTF_8), 64 * 1024)) {
            AuditCsv.writeHeader(out);
            queries.stream(filter, range, MAX_EXPORT_ROWS, row -> {
                try {
                    AuditCsv.writeEntry(out, row);
                    written[0]++;
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
        } catch (IOException | UncheckedIOException e) {
            detail.put("rowCount", written[0]);
            detail.put("reason", "aborted");
            audit(Outcome.FAILURE, detail);
            throw new UncheckedIOException("Audit export aborted after " + written[0] + " rows",
                    e instanceof IOException io ? io : ((UncheckedIOException) e).getCause());
        }
        detail.put("rowCount", written[0]);
        audit(Outcome.SUCCESS, detail);
        return written[0];
    }

    private void audit(Outcome outcome, Map<String, Object> detail) {
        events.publishEvent(AuditEvents.current("AUDIT_EXPORTED", "AUDIT_LOG", null, outcome, detail));
    }

    private AuditEntryDto toDto(AuditRow r) {
        return new AuditEntryDto(r.id(), r.occurredAt(), r.userId(), r.username(), r.action(), r.resourceType(),
                r.resourceId(), r.outcome(), r.ip(), r.userAgent(),
                r.detailJson() == null ? null : json.readTree(r.detailJson()));
    }
}
