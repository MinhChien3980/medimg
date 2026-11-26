package com.medimg.identity.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashSet;
import java.util.Set;
import java.util.random.RandomGenerator;

import org.junit.jupiter.api.Test;

class TemporaryPasswordsTest {

    @Test
    void sixteenCharactersOfTheUnambiguousAlphabetThatPassThePolicy() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 2000; i++) {
            String password = TemporaryPasswords.generate("doctor");
            assertThat(password).hasSize(TemporaryPasswords.LENGTH);
            assertThat(password.chars()).allMatch(c -> TemporaryPasswords.ALPHABET.indexOf(c) >= 0);
            assertThat(password).doesNotContainAnyWhitespaces().doesNotContain("0", "O", "1", "l", "I");
            assertThat(PasswordPolicy.check(password, "doctor")).isEmpty();
            seen.add(password);
        }
        assertThat(seen).hasSize(2000);
    }

    @Test
    void drawsAgainWhenADrawBreaksThePolicy() {
        // first draw: only letters (no digit); second: contains the username "abc"; third: acceptable
        String first = "ABCDEFGHJKLMNPQR";
        String second = "abc23456789abcde";
        String third = "Zz23456789Zz2345";
        RandomGenerator scripted = new Scripted(first + second + third);

        assertThat(TemporaryPasswords.generate("abc", scripted)).isEqualTo(third);
    }

    /** Returns the alphabet index of each character of the script in turn. */
    private static final class Scripted implements RandomGenerator {
        private final String script;
        private int next;

        Scripted(String script) {
            this.script = script;
        }

        @Override
        public int nextInt(int bound) {
            return TemporaryPasswords.ALPHABET.indexOf(script.charAt(next++));
        }

        @Override
        public long nextLong() {
            throw new UnsupportedOperationException();
        }
    }
}
