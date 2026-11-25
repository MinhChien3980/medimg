package com.medimg.shared.audit;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/** Published as a Spring application event; the audit module persists it. */
public record AuditEvent(
        Instant occurredAt,
        UUID userId,
        String username,
        String action,
        String resourceType,
        String resourceId,
        Outcome outcome,
        String ip,
        String userAgent,
        Map<String, Object> detail) {

    public enum Outcome { SUCCESS, FAILURE }
}
