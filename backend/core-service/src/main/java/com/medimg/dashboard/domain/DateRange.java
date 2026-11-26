package com.medimg.dashboard.domain;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;

/**
 * A range of whole days, both ends included, in a given time zone. Without {@code to} it ends today; without
 * {@code from} it covers the {@value #DEFAULT_DAYS} days up to {@code to}. At most {@value #MAX_DAYS} days.
 */
public record DateRange(LocalDate from, LocalDate to) {

    public static final int DEFAULT_DAYS = 30;
    public static final int MAX_DAYS = 366;

    /** @throws IllegalArgumentException when {@code from} is after {@code to} or the range is too long */
    public DateRange {
        if (from.isAfter(to)) {
            throw new IllegalArgumentException("from (" + from + ") must not be after to (" + to + ")");
        }
        long days = ChronoUnit.DAYS.between(from, to) + 1;
        if (days > MAX_DAYS) {
            throw new IllegalArgumentException("The range covers " + days + " days, at most " + MAX_DAYS + " are allowed");
        }
    }

    public static DateRange resolve(LocalDate from, LocalDate to, LocalDate today) {
        LocalDate end = to != null ? to : today;
        LocalDate start = from != null ? from : end.minusDays(DEFAULT_DAYS - 1L);
        return new DateRange(start, end);
    }

    public long days() {
        return ChronoUnit.DAYS.between(from, to) + 1;
    }

    /** The first instant of {@code from} in the zone (midnight, or the first instant after a DST gap). */
    public Instant start(ZoneId zone) {
        return from.atStartOfDay(zone).toInstant();
    }

    /** The first instant after the range: midnight starting the day after {@code to}. */
    public Instant endExclusive(ZoneId zone) {
        return to.plusDays(1).atStartOfDay(zone).toInstant();
    }
}
