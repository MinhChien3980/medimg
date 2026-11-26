package com.medimg.identity.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.Test;

class AppUserTest {

    private static final Instant NOW = Instant.parse("2026-11-26T08:00:00Z");

    private static AppUser doctor() {
        return new AppUser("doctor", "hash", "Demo Doctor", null, Set.of(Role.DOCTOR), NOW);
    }

    @Test
    void ownPasswordAccountIsActiveWithoutChangeRequired() {
        AppUser u = doctor();
        assertThat(u.getStatus()).isEqualTo(UserStatus.ACTIVE);
        assertThat(u.isPasswordChangeRequired()).isFalse();
        assertThat(u.isLocked()).isFalse();
    }

    @Test
    void accountCreatedByAnAdminMustChangeItsTemporaryPassword() {
        AppUser u = AppUser.withTemporaryPassword("nurse", "tmp-hash", "Nurse", "n@example.org", Set.of(Role.TECHNICIAN), NOW);
        assertThat(u.isPasswordChangeRequired()).isTrue();
        assertThat(u.getPasswordHash()).isEqualTo("tmp-hash");
        assertThatThrownBy(() -> AppUser.withTemporaryPassword("x", "h", "X", null, Set.of(), NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AppUser.withTemporaryPassword("x", null, "X", null, Set.of(Role.DOCTOR), NOW))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    void lockAndUnlockAreIdempotent() {
        AppUser u = doctor();
        UUID admin = UUID.randomUUID();

        assertThat(u.lock(admin, NOW)).isTrue();
        assertThat(u.isLocked()).isTrue();
        assertThat(u.getLockedAt()).isEqualTo(NOW);
        assertThat(u.getLockedBy()).isEqualTo(admin);
        assertThat(u.lock(UUID.randomUUID(), NOW.plusSeconds(60))).isFalse();
        assertThat(u.getLockedBy()).isEqualTo(admin);

        assertThat(u.unlock()).isTrue();
        assertThat(u.getStatus()).isEqualTo(UserStatus.ACTIVE);
        assertThat(u.getLockedAt()).isNull();
        assertThat(u.getLockedBy()).isNull();
        assertThat(u.unlock()).isFalse();
    }

    @Test
    void resetRequiresAChangeAndChangeClearsIt() {
        AppUser u = doctor();
        u.resetPassword("tmp", NOW);
        assertThat(u.isPasswordChangeRequired()).isTrue();
        assertThat(u.getPasswordHash()).isEqualTo("tmp");
        assertThat(u.getPasswordChangedAt()).isEqualTo(NOW);

        u.changePassword("own", NOW.plusSeconds(5));
        assertThat(u.isPasswordChangeRequired()).isFalse();
        assertThat(u.getPasswordHash()).isEqualTo("own");
        assertThat(u.getPasswordChangedAt()).isEqualTo(NOW.plusSeconds(5));
    }

    @Test
    void updateKeepsAtLeastOneRole() {
        AppUser u = doctor();
        u.update("Dr. Who", "who@example.org", Set.of(Role.DOCTOR, Role.ADMIN));
        assertThat(u.getRoles()).containsExactlyInAnyOrder(Role.DOCTOR, Role.ADMIN);
        assertThat(u.hasRole(Role.ADMIN)).isTrue();
        assertThat(u.getFullName()).isEqualTo("Dr. Who");
        assertThat(u.getEmail()).isEqualTo("who@example.org");
        assertThatThrownBy(() -> u.update("X", null, Set.of())).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void onlyARotatedRefreshTokenCountsAsReplayed() {
        RefreshToken rotated = new RefreshToken(UUID.randomUUID(), "h1", NOW.plusSeconds(60), NOW);
        RefreshToken loggedOut = new RefreshToken(UUID.randomUUID(), "h2", NOW.plusSeconds(60), NOW);
        assertThat(rotated.wasRotated()).isFalse();

        rotated.revoke(NOW, RefreshToken.RevokedReason.ROTATED);
        loggedOut.revoke(NOW, RefreshToken.RevokedReason.LOGOUT);
        loggedOut.revoke(NOW, RefreshToken.RevokedReason.ROTATED); // the first reason stays

        assertThat(rotated.wasRotated()).isTrue();
        assertThat(loggedOut.isRevoked()).isTrue();
        assertThat(loggedOut.wasRotated()).isFalse();
        assertThat(loggedOut.getRevokedReason()).isEqualTo(RefreshToken.RevokedReason.LOGOUT);
    }
}
