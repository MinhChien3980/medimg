package com.medimg.identity.domain;

import static com.medimg.identity.domain.PasswordPolicy.Violation.CONTAINS_USERNAME;
import static com.medimg.identity.domain.PasswordPolicy.Violation.NO_DIGIT;
import static com.medimg.identity.domain.PasswordPolicy.Violation.NO_LETTER;
import static com.medimg.identity.domain.PasswordPolicy.Violation.TOO_LONG;
import static com.medimg.identity.domain.PasswordPolicy.Violation.TOO_SHORT;
import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class PasswordPolicyTest {

    @Test
    void acceptsTenCharactersWithLettersAndDigits() {
        assertThat(PasswordPolicy.check("abcdefgh12", "doctor")).isEmpty();
        assertThat(PasswordPolicy.check("Correct horse battery 9", "doctor")).isEmpty();
    }

    @Test
    void requiresAtLeastTenCharacters() {
        assertThat(PasswordPolicy.check("abcdefg12", "doctor")).containsExactly(TOO_SHORT);
        assertThat(PasswordPolicy.check("", "doctor")).containsExactly(TOO_SHORT, NO_LETTER, NO_DIGIT);
        assertThat(PasswordPolicy.check(null, "doctor")).containsExactly(TOO_SHORT, NO_LETTER, NO_DIGIT);
    }

    @Test
    void countsCharactersNotBytesOrUtf16Units() {
        // 9 letters outside the BMP (2 UTF-16 units each) and one digit: 10 characters
        assertThat(PasswordPolicy.check("𝒜".repeat(9) + "1", "doctor")).isEmpty();
        assertThat(PasswordPolicy.check("𝒜".repeat(8) + "1", "doctor")).containsExactly(TOO_SHORT);
    }

    @Test
    void acceptsLettersOfAnyScript() {
        assertThat(PasswordPolicy.check("mậtkhẩucủatôi2026", "doctor")).isEmpty();
    }

    @Test
    void requiresALetterAndADigit() {
        assertThat(PasswordPolicy.check("abcdefghijk", "doctor")).containsExactly(NO_DIGIT);
        assertThat(PasswordPolicy.check("12345678901", "doctor")).containsExactly(NO_LETTER);
        assertThat(PasswordPolicy.check("!!!!!!!!!!!!", "doctor")).containsExactly(NO_LETTER, NO_DIGIT);
    }

    @Test
    void mustNotContainTheUsernameIgnoringCase() {
        assertThat(PasswordPolicy.check("myDOCTOR2026x", "doctor")).containsExactly(CONTAINS_USERNAME);
        assertThat(PasswordPolicy.check("doctor123456", "Doctor")).containsExactly(CONTAINS_USERNAME);
        assertThat(PasswordPolicy.check("docto123456", "doctor")).isEmpty();
        assertThat(PasswordPolicy.check("abcdefgh12", null)).isEmpty();
    }

    @Test
    void atMostSeventyTwoBytesBecauseBcryptIgnoresTheRest() {
        assertThat(PasswordPolicy.check("a".repeat(71) + "1", "doctor")).isEmpty();
        assertThat(PasswordPolicy.check("a".repeat(72) + "1", "doctor")).containsExactly(TOO_LONG);
        // 36 two-byte letters = 72 bytes, plus a digit
        assertThat(PasswordPolicy.check("é".repeat(36) + "1", "doctor")).containsExactly(TOO_LONG);
        assertThat(PasswordPolicy.check("é".repeat(35) + "1", "doctor")).isEmpty();
    }
}
