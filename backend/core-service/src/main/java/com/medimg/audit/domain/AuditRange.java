package com.medimg.audit.domain;

import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;

/**
 * The time range an audit query covers, {@code from} included and {@code to} excluded. It is required and bounded
 * ({@value #MAX_DAYS} days at most, {@value #DEFAULT_DAYS} by default) so that a query only touches a few monthly
 * partitions of the log.
 * <p>
 * A bound is either an ISO-8601 date-time with an offset ({@code 2026-11-26T08:00:00Z},
 * {@code 2026-11-26T15:00:00+07:00}) or a date ({@code 2026-11-26}), which stands for whole days in the given zone:
 * as {@code from} the start of that day, as {@code to} the end of it.
 */
public record AuditRange(Instant from, Instant to) {

    public static final int MAX_DAYS = 93;
    public static final int DEFAULT_DAYS = 7;

    /** @throws IllegalArgumentException when from is not before to, or the range is longer than {@value #MAX_DAYS} days */
    public AuditRange {
        if (!from.isBefore(to)) {
            throw new IllegalArgumentException("from (" + from + ") must be before to (" + to + ")");
        }
        if (Duration.between(from, to).compareTo(Duration.ofDays(MAX_DAYS)) > 0) {
            throw new IllegalArgumentException("The range may cover at most " + MAX_DAYS + " days");
        }
    }

    /**
     * Without {@code to} the range ends now; without {@code from} it starts {@value #DEFAULT_DAYS} days before its end.
     *
     * @throws IllegalArgumentException for a value that is neither a date nor a date-time with offset, or a bad range
     */
    public static AuditRange resolve(String from, String to, ZoneId zone, Instant now) {
        Instant end = blank(to) ? now : parse(to.trim(), true, zone);
        Instant start = blank(from) ? end.minus(Duration.ofDays(DEFAULT_DAYS)) : parse(from.trim(), false, zone);
        return new AuditRange(start, end);
    }

    private static Instant parse(String value, boolean end, ZoneId zone) {
        try {
            if (value.length() == 10) {
                LocalDate day = LocalDate.parse(value);
                return (end ? day.plusDays(1) : day).atStartOfDay(zone).toInstant();
            }
            return OffsetDateTime.parse(value).toInstant();
        } catch (DateTimeException e) {
            throw new IllegalArgumentException("'" + value + "' is neither a date (YYYY-MM-DD) nor an ISO-8601 date-time"
                    + " with offset");
        }
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
