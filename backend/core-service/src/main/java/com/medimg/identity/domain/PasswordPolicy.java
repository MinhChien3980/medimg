package com.medimg.identity.domain;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Rules for a password a user chooses: at least {@value #MIN_LENGTH} characters, at most {@value #MAX_BYTES} bytes
 * in UTF-8 (BCrypt ignores anything beyond), at least one letter and one digit, and not containing the username
 * (ignoring case). That it differs from the current password is checked against the stored hash by the caller.
 */
public final class PasswordPolicy {

    public static final int MIN_LENGTH = 10;
    public static final int MAX_BYTES = 72;

    /** Machine-readable reasons, shown to the user in their language by the client. */
    public enum Violation { TOO_SHORT, TOO_LONG, NO_LETTER, NO_DIGIT, CONTAINS_USERNAME, SAME_AS_CURRENT }

    private PasswordPolicy() {
    }

    /** The rules {@code password} breaks; empty when it is acceptable. */
    public static List<Violation> check(String password, String username) {
        List<Violation> out = new ArrayList<>();
        String value = password == null ? "" : password;
        if (value.codePointCount(0, value.length()) < MIN_LENGTH) {
            out.add(Violation.TOO_SHORT);
        }
        if (value.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            out.add(Violation.TOO_LONG);
        }
        if (value.codePoints().noneMatch(Character::isLetter)) {
            out.add(Violation.NO_LETTER);
        }
        if (value.codePoints().noneMatch(Character::isDigit)) {
            out.add(Violation.NO_DIGIT);
        }
        if (username != null && !username.isBlank()
                && value.toLowerCase(Locale.ROOT).contains(username.toLowerCase(Locale.ROOT))) {
            out.add(Violation.CONTAINS_USERNAME);
        }
        return out;
    }
}
