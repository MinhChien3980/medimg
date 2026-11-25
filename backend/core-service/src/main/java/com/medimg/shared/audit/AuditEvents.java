package com.medimg.shared.audit;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.security.CurrentUser;

/** Builds {@link AuditEvent}s, filling client IP / user agent from the current HTTP request when there is one. */
public final class AuditEvents {

    private AuditEvents() {
    }

    public static AuditEvent of(String action, String resourceType, Object resourceId, Outcome outcome,
                                UUID userId, String username, Map<String, Object> detail) {
        String ip = null;
        String ua = null;
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs) {
            ip = attrs.getRequest().getRemoteAddr();
            ua = attrs.getRequest().getHeader("User-Agent");
        }
        return new AuditEvent(Instant.now(), userId, username, action, resourceType,
                resourceId == null ? null : resourceId.toString(), outcome, ip, ua,
                detail == null ? Map.of() : detail);
    }

    /** Event attributed to the currently authenticated user. */
    public static AuditEvent current(String action, String resourceType, Object resourceId, Outcome outcome,
                                     Map<String, Object> detail) {
        return of(action, resourceType, resourceId, outcome,
                CurrentUser.idIfPresent().orElse(null), CurrentUser.username().orElse(null), detail);
    }
}
