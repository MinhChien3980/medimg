package com.medimg.dashboard.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import com.medimg.dashboard.application.DashboardDtos.DashboardDto;
import com.medimg.dashboard.application.DashboardDtos.Review;
import com.medimg.dashboard.infrastructure.DashboardQueries;
import com.medimg.shared.web.ApiException;

class DashboardServiceTest {

    // 2026-11-25 20:00 UTC is already 2026-11-26 03:00 in Ho Chi Minh City
    private static final Instant NOW = Instant.parse("2026-11-25T20:00:00Z");

    private final DashboardQueries queries = mock(DashboardQueries.class);
    private final DashboardService service = new DashboardService(queries,
            new DashboardProperties(ZoneId.of("Asia/Ho_Chi_Minh")), Clock.fixed(NOW, ZoneOffset.UTC));

    @Test
    void todayIsTakenInTheDashboardZone() {
        assertThat(service.range(null, null).to()).isEqualTo(LocalDate.of(2026, 11, 26));
    }

    @Test
    void aBadRangeIsA400() {
        assertThatThrownBy(() -> service.range(LocalDate.of(2026, 11, 2), LocalDate.of(2026, 11, 1)))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(e.getBody().getType().toString()).isEqualTo("/problems/invalid-date-range");
                });
        assertThatThrownBy(() -> service.range(LocalDate.of(2025, 1, 1), LocalDate.of(2026, 1, 2)))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void acceptanceRateCountsEditedAsKeptAndIsNullWithoutReviews() {
        assertThat(DashboardService.review(Map.of())).isEqualTo(new Review(0, 0, 0, 0, null));
        assertThat(DashboardService.review(Map.of("ACCEPTED", 1L, "EDITED", 1L, "REJECTED", 1L)))
                .isEqualTo(new Review(3, 1, 1, 1, 0.6667));
        assertThat(DashboardService.review(Map.of("REJECTED", 4L)).acceptanceRate()).isEqualTo(0.0);
    }

    @Test
    void totalsAreTheSumsOfTheirBreakdowns() {
        when(queries.cases(any())).thenReturn(4L);
        when(queries.studiesByInputType(any())).thenReturn(Map.of("IMAGE_2D", 3L, "NIFTI", 2L));
        when(queries.jobsByStatus(any())).thenReturn(Map.of("DONE", 5L, "FAILED", 1L));
        when(queries.reportsByStatus(any())).thenReturn(Map.of("FINAL", 2L));
        when(queries.reviewsByStatus(any())).thenReturn(Map.of());

        DashboardDto d = service.dashboard(null, null);

        assertThat(d.zone()).isEqualTo("Asia/Ho_Chi_Minh");
        assertThat(d.totals().cases()).isEqualTo(4);
        assertThat(d.totals().studies()).isEqualTo(5);
        assertThat(d.totals().jobs()).isEqualTo(6);
        assertThat(d.totals().reports().draft()).isZero();
        assertThat(d.totals().reports().finalCount()).isEqualTo(2);
        assertThat(d.review().acceptanceRate()).isNull();
        assertThat(d.labels()).isEqualTo(List.of());
    }
}
