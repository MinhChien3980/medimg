package com.medimg.identity.application;

import java.util.UUID;

/** A user as shown next to what they did (reviewed, drew, signed); {@code fullName} falls back to the username. */
public record UserRef(UUID id, String fullName) {
}
