package com.medimg.shared.persistence;

import java.util.Locale;

/** SQL {@code LIKE} patterns for a text search, to be used with {@code ESCAPE '!'} against a lower-cased column. */
public final class LikePatterns {

    private LikePatterns() {
    }

    /**
     * A lower-case pattern matching values that contain {@code text}, its wildcards ({@code %}, {@code _}) and the
     * escape character itself taken literally; null when {@code text} is null or blank.
     */
    public static String contains(String text) {
        String q = text == null ? "" : text.trim().toLowerCase(Locale.ROOT);
        if (q.isEmpty()) {
            return null;
        }
        return "%" + q.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
    }
}
