package com.medimg.report.domain;

import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Locale;

import jakarta.persistence.AttributeConverter;

/**
 * The language a report is written in; it also sets the time zone of the times it shows: Vietnam time for a
 * Vietnamese report, UTC (said so) for an English one.
 */
public enum ReportLanguage {
    VI("vi", ZoneId.of("Asia/Ho_Chi_Minh")),
    EN("en", ZoneOffset.UTC);

    private final String tag;
    private final ZoneId zone;

    ReportLanguage(String tag, ZoneId zone) {
        this.tag = tag;
        this.zone = zone;
    }

    /** @throws IllegalArgumentException for a language other than vi and en */
    public static ReportLanguage of(String tag) {
        return Arrays.stream(values()).filter(l -> l.tag.equals(tag)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unsupported report language " + tag));
    }

    /** The language tag, as stored and in the API ({@code vi}, {@code en}). */
    public String tag() {
        return tag;
    }

    public Locale locale() {
        return Locale.of(tag);
    }

    public ZoneId zone() {
        return zone;
    }

    /** Stores the language tag. */
    public static class Converter implements AttributeConverter<ReportLanguage, String> {

        @Override
        public String convertToDatabaseColumn(ReportLanguage language) {
            return language == null ? null : language.tag;
        }

        @Override
        public ReportLanguage convertToEntityAttribute(String tag) {
            return tag == null ? null : of(tag);
        }
    }
}
