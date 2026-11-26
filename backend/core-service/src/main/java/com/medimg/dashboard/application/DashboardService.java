package com.medimg.dashboard.application;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Map;

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.dashboard.application.DashboardDtos.DashboardDto;
import com.medimg.dashboard.application.DashboardDtos.Processing;
import com.medimg.dashboard.application.DashboardDtos.ReportCounts;
import com.medimg.dashboard.application.DashboardDtos.Review;
import com.medimg.dashboard.application.DashboardDtos.Totals;
import com.medimg.dashboard.domain.DateRange;
import com.medimg.dashboard.infrastructure.DashboardQueries;
import com.medimg.shared.web.ApiException;

/** Builds the dashboard of a date range from aggregate queries; see {@link DashboardDtos} for what each figure means. */
@Service
public class DashboardService {

    private final DashboardQueries queries;
    private final ZoneId zone;
    private final Clock clock;

    DashboardService(DashboardQueries queries, DashboardProperties props, Clock clock) {
        this.queries = queries;
        this.zone = props.zone();
        this.clock = clock;
    }

    /**
     * Without dates: the last {@value DateRange#DEFAULT_DAYS} days up to today in the dashboard time zone. A range
     * that ends before it starts or is longer than {@value DateRange#MAX_DAYS} days is a 400. The queries read one
     * snapshot of the data (repeatable read), so that the figures agree with each other.
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public DashboardDto dashboard(LocalDate from, LocalDate to) {
        DateRange range = range(from, to);
        MapSqlParameterSource p = DashboardQueries.params(range, zone);

        Map<String, Long> studies = queries.studiesByInputType(p);
        Map<String, Long> jobs = queries.jobsByStatus(p);
        Map<String, Long> reports = queries.reportsByStatus(p);
        Totals totals = new Totals(queries.cases(p), sum(studies), studies, sum(jobs), jobs,
                new ReportCounts(reports.getOrDefault("DRAFT", 0L), reports.getOrDefault("FINAL", 0L)));

        return new DashboardDto(range.from(), range.to(), zone.getId(), totals, new Processing(queries.timings(p)),
                review(queries.reviewsByStatus(p)), queries.topLabels(p), queries.daily(p), queries.recentJobs(p));
    }

    DateRange range(LocalDate from, LocalDate to) {
        try {
            return DateRange.resolve(from, to, LocalDate.now(clock.withZone(zone)));
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(e.getMessage()).type("invalid-date-range");
        }
    }

    static Review review(Map<String, Long> byStatus) {
        long accepted = byStatus.getOrDefault("ACCEPTED", 0L);
        long edited = byStatus.getOrDefault("EDITED", 0L);
        long rejected = byStatus.getOrDefault("REJECTED", 0L);
        long reviewed = accepted + edited + rejected;
        Double rate = reviewed == 0 ? null
                : BigDecimal.valueOf(accepted + edited).divide(BigDecimal.valueOf(reviewed), 4, RoundingMode.HALF_UP)
                .doubleValue();
        return new Review(reviewed, accepted, edited, rejected, rate);
    }

    private static long sum(Map<String, Long> counts) {
        return counts.values().stream().mapToLong(Long::longValue).sum();
    }
}
