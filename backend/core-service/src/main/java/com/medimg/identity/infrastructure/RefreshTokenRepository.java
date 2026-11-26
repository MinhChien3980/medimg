package com.medimg.identity.infrastructure;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import com.medimg.identity.domain.RefreshToken;
import com.medimg.identity.domain.RefreshToken.RevokedReason;

public interface RefreshTokenRepository extends JpaRepository<RefreshToken, UUID> {

    Optional<RefreshToken> findByTokenHash(String tokenHash);

    @Modifying(flushAutomatically = true)
    @Query("""
            update RefreshToken t set t.revokedAt = :at, t.revokedReason = :reason
            where t.userId = :userId and t.revokedAt is null
            """)
    int revokeAllForUser(UUID userId, Instant at, RevokedReason reason);

    /** Revokes every session of the user except {@code keep}, the session the request comes from. */
    @Modifying(flushAutomatically = true)
    @Query("""
            update RefreshToken t set t.revokedAt = :at, t.revokedReason = :reason
            where t.userId = :userId and t.revokedAt is null and t.id <> :keep
            """)
    int revokeOthersForUser(UUID userId, UUID keep, Instant at, RevokedReason reason);
}
