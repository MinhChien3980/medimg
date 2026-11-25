package com.medimg.shared.security;

import java.util.Optional;
import java.util.UUID;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

/** Access to the authenticated user carried in the JWT (subject = user id). */
public final class CurrentUser {

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

    public static Optional<String> username() {
        return jwt().map(j -> j.getClaimAsString("preferred_username"));
    }
}
