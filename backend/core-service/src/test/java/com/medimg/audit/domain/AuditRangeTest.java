package com.medimg.audit.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

class AuditRangeTest {

    private static final Instant NOW = Instant.parse("2026-11-26T08:30:00Z");
    private static final ZoneId HCM = ZoneId.of("Asia/Ho_Chi_Minh");

    @Test
    void defaultsToTheLastSevenDays() {
        AuditRange r = AuditRange.resolve(null, " ", HCM, NOW);
        assertThat(r.to()).isEqualTo(NOW);
        assertThat(r.from()).isEqualTo(NOW.minus(Duration.ofDays(7)));
    }

    @Test
    void datesAreWholeDaysInTheZoneBothIncluded() {
        AuditRange r = AuditRange.resolve("2026-11-01", "2026-11-26", HCM, NOW);
        assertThat(r.from()).isEqualTo(Instant.parse("2026-10-31T17:00:00Z"));
        assertThat(r.to()).isEqualTo(Instant.parse("2026-11-26T17:00:00Z"));
        AuditRange oneDay = AuditRange.resolve("2026-11-26", "2026-11-26", HCM, NOW);
        assertThat(Duration.between(oneDay.from(), oneDay.to())).isEqualTo(Duration.ofDays(1));
    }

    @Test
    void dateTimesNeedAnOffsetAndAreTakenAsTheyAre() {
        AuditRange r = AuditRange.resolve("2026-11-26T07:00:00+07:00", "2026-11-26T08:00:00Z", HCM, NOW);
        assertThat(r.from()).isEqualTo(Instant.parse("2026-11-26T00:00:00Z"));
        assertThat(r.to()).isEqualTo(Instant.parse("2026-11-26T08:00:00Z"));
        assertThatThrownBy(() -> AuditRange.resolve("2026-11-26T07:00:00", null, HCM, NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AuditRange.resolve("yesterday", null, HCM, NOW))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("'yesterday'");
        assertThatThrownBy(() -> AuditRange.resolve("2026-13-01", null, HCM, NOW)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void fromMustBeBeforeTo() {
        assertThatThrownBy(() -> AuditRange.resolve("2026-11-26T08:00:00Z", "2026-11-26T08:00:00Z", HCM, NOW))
                .hasMessageContaining("must be before");
        assertThatThrownBy(() -> AuditRange.resolve("2026-11-27", "2026-11-26", HCM, NOW))
                .isInstanceOf(IllegalArgumentException.class);
        // only from given, after now
        assertThatThrownBy(() -> AuditRange.resolve("2026-12-01", null, HCM, NOW)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void atMostNinetyThreeDays() {
        Instant to = Instant.parse("2026-11-26T00:00:00Z");
        assertThat(new AuditRange(to.minus(Duration.ofDays(93)), to)).isNotNull();
        assertThatThrownBy(() -> new AuditRange(to.minus(Duration.ofDays(93)).minusSeconds(1), to))
                .hasMessageContaining("at most 93 days");
        // 93 whole days given as dates
        assertThat(AuditRange.resolve("2026-08-26", "2026-11-26", HCM, NOW)).isNotNull();
        assertThatThrownBy(() -> AuditRange.resolve("2026-08-25", "2026-11-26", HCM, NOW))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void blankFiltersAreAbsentAndOnlySetOnesAreListed() {
        UUID user = UUID.randomUUID();
        AuditFilter f = new AuditFilter(user, " ", "LOGIN", "", null, "FAILURE");
        assertThat(f.username()).isNull();
        assertThat(f.entityType()).isNull();
        assertThat(f.asMap()).isEqualTo(Map.of("userId", user.toString(), "action", "LOGIN", "outcome", "FAILURE"));
        assertThat(AuditFilter.NONE.asMap()).isEmpty();
        assertThat(new AuditFilter(null, " ad ", null, "USER", "42", null).asMap())
                .isEqualTo(Map.of("username", "ad", "entityType", "USER", "entityId", "42"));
    }
}
