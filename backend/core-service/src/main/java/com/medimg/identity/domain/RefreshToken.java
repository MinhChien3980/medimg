package com.medimg.identity.domain;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * Only the SHA-256 hash of the opaque refresh token is stored, so a DB leak does not leak usable tokens. The id of the
 * token is the session id ({@code sid} claim) of the access token issued with it.
 */
@Entity
@Table(name = "refresh_token")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class RefreshToken {

    /**
     * Why a token was revoked. Only a {@link #ROTATED} token presented again means that it was stolen; the others are
     * simply refused.
     */
    public enum RevokedReason { ROTATED, LOGOUT, REUSE_DETECTED, LOCKED, PASSWORD_RESET, PASSWORD_CHANGED }

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "token_hash", nullable = false, unique = true, columnDefinition = "bpchar(64)")
    private String tokenHash;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Enumerated(EnumType.STRING)
    @Column(name = "revoked_reason")
    private RevokedReason revokedReason;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    public RefreshToken(UUID userId, String tokenHash, Instant expiresAt, Instant now) {
        this.id = UUID.randomUUID();
        this.userId = userId;
        this.tokenHash = tokenHash;
        this.expiresAt = expiresAt;
        this.createdAt = now;
    }

    public boolean isRevoked() {
        return revokedAt != null;
    }

    /**
     * True if the token was already exchanged for a new one, so that presenting it again is a replay. Tokens revoked
     * before the reason was recorded count as rotated.
     */
    public boolean wasRotated() {
        return revokedAt != null && (revokedReason == null || revokedReason == RevokedReason.ROTATED);
    }

    public boolean isExpired(Instant now) {
        return !expiresAt.isAfter(now);
    }

    public void revoke(Instant at, RevokedReason reason) {
        if (revokedAt == null) {
            revokedAt = at;
            revokedReason = reason;
        }
    }
}
