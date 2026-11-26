package com.medimg.shared.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class LikePatternsTest {

    @Test
    void blankTextIsNoFilter() {
        assertThat(LikePatterns.contains(null)).isNull();
        assertThat(LikePatterns.contains("   ")).isNull();
    }

    @Test
    void textIsALiteralCaseInsensitiveSubstring() {
        assertThat(LikePatterns.contains(" DoC ")).isEqualTo("%doc%");
        assertThat(LikePatterns.contains("50%_a!b")).isEqualTo("%50!%!_a!!b%");
    }
}
