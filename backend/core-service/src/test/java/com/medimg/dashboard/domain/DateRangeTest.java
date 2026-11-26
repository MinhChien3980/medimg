package com.medimg.dashboard.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

import org.junit.jupiter.api.Test;

class DateRangeTest {

    private static final LocalDate TODAY = LocalDate.of(2026, 11, 26);
    private static final ZoneId HCM = ZoneId.of("Asia/Ho_Chi_Minh");

    @Test
    void defaultsToTheLastThirtyDaysUpToToday() {
        DateRange r = DateRange.resolve(null, null, TODAY);
        assertThat(r.from()).isEqualTo(LocalDate.of(2026, 10, 28));
        assertThat(r.to()).isEqualTo(TODAY);
        assertThat(r.days()).isEqualTo(30);
    }

    @Test
    void aMissingBoundIsFilledFromTheOther() {
        assertThat(DateRange.resolve(LocalDate.of(2026, 11, 1), null, TODAY).to()).isEqualTo(TODAY);
        assertThat(DateRange.resolve(null, LocalDate.of(2026, 1, 30), TODAY).from()).isEqualTo(LocalDate.of(2026, 1, 1));
    }

    @Test
    void aSingleDayIsAllowed() {
        assertThat(DateRange.resolve(TODAY, TODAY, TODAY).days()).isEqualTo(1);
    }

    @Test
    void fromAfterToIsRefused() {
        assertThatThrownBy(() -> DateRange.resolve(TODAY.plusDays(1), TODAY, TODAY))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("must not be after");
        // only from given, in the future: it ends today, before it starts
        assertThatThrownBy(() -> DateRange.resolve(TODAY.plusDays(1), null, TODAY)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void atMost366DaysIncludingALeapYear() {
        assertThat(new DateRange(LocalDate.of(2027, 12, 31), LocalDate.of(2028, 12, 30)).days()).isEqualTo(366);
        assertThat(new DateRange(LocalDate.of(2028, 1, 1), LocalDate.of(2028, 12, 31)).days()).isEqualTo(366);
        assertThatThrownBy(() -> new DateRange(LocalDate.of(2027, 12, 31), LocalDate.of(2028, 12, 31)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("367 days");
    }

    @Test
    void daysBeginAtMidnightInTheZone() {
        DateRange r = new DateRange(LocalDate.of(2026, 11, 26), LocalDate.of(2026, 11, 26));
        assertThat(r.start(HCM)).isEqualTo(Instant.parse("2026-11-25T17:00:00Z"));
        assertThat(r.endExclusive(HCM)).isEqualTo(Instant.parse("2026-11-26T17:00:00Z"));
    }

    @Test
    void aDayWithADaylightSavingChangeIsShorterOrLonger() {
        ZoneId paris = ZoneId.of("Europe/Paris");
        DateRange springForward = new DateRange(LocalDate.of(2026, 3, 29), LocalDate.of(2026, 3, 29));
        assertThat(java.time.Duration.between(springForward.start(paris), springForward.endExclusive(paris)).toHours())
                .isEqualTo(23);
    }
}
