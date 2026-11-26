package com.medimg.identity.domain;

import java.security.SecureRandom;
import java.util.random.RandomGenerator;

/**
 * One-time passwords given to a user by an admin (new account, reset). {@value #LENGTH} characters drawn uniformly by a
 * {@link SecureRandom} from {@value #ALPHABET} (no look-alike characters such as 0/O and 1/l/I, so it can be read out
 * and typed): about 93 bits of entropy. A draw that breaks {@link PasswordPolicy} for the user (no digit, no letter,
 * containing the username) is discarded, so the password is always one the user could have chosen.
 */
public final class TemporaryPasswords {

    public static final int LENGTH = 16;
    static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

    private static final SecureRandom RANDOM = new SecureRandom();

    private TemporaryPasswords() {
    }

    public static String generate(String username) {
        return generate(username, RANDOM);
    }

    static String generate(String username, RandomGenerator random) {
        while (true) {
            StringBuilder sb = new StringBuilder(LENGTH);
            for (int i = 0; i < LENGTH; i++) {
                sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
            }
            String candidate = sb.toString();
            if (PasswordPolicy.check(candidate, username).isEmpty()) {
                return candidate;
            }
        }
    }
}
