package com.medimg.shared.security;

import java.util.Optional;
import java.util.UUID;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

/** Access to the authenticated user carried in the JWT (subject = user id). */
public final class CurrentUser {

    /** Claim of the access token naming the session it belongs to. */
    public static final String SESSION_CLAIM = "sid";

    private CurrentUser() {
    }

    public static Optional<Jwt> jwt() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof Jwt jwt) {
            return Optional.of(jwt);
        }
        return Optional.empty();
    }

    public static UUID id() {
        return jwt().map(j -> UUID.fromString(j.getSubject()))
                .orElseThrow(() -> new IllegalStateException("No authenticated user"));
    }

    public static Optional<UUID> idIfPresent() {
        return jwt().map(j -> UUID.fromString(j.getSubject()));
    }

    /** The session (refresh token) the access token was issued with; absent in tokens issued before sessions had ids. */
    public static Optional<UUID> sessionId() {
        return jwt().map(j -> j.getClaimAsString(SESSION_CLAIM)).map(UUID::fromString);
    }

    public static Optional<String> username() {
        return jwt().map(j -> j.getClaimAsString("preferred_username"));
    }
}
