package com.medimg.audit.domain;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Optional filters of an audit query; a null field does not filter. {@code username} matches part of the username,
 * ignoring case; the others match exactly. {@code entityType} / {@code entityId} are the resource type and id.
 */
public record AuditFilter(UUID userId, String username, String action, String entityType, String entityId,
                          String outcome) {

    public static final AuditFilter NONE = new AuditFilter(null, null, null, null, null, null);

    /** Blank values count as absent. */
    public AuditFilter {
        username = blankToNull(username);
        action = blankToNull(action);
        entityType = blankToNull(entityType);
        entityId = blankToNull(entityId);
        outcome = blankToNull(outcome);
    }

    /** The filters that are set, by name, e.g. for the audit record of an export. */
    public Map<String, Object> asMap() {
        Map<String, Object> out = new LinkedHashMap<>();
        if (userId != null) {
            out.put("userId", userId.toString());
        }
        putIfSet(out, "username", username);
        putIfSet(out, "action", action);
        putIfSet(out, "entityType", entityType);
        putIfSet(out, "entityId", entityId);
        putIfSet(out, "outcome", outcome);
        return out;
    }

    private static void putIfSet(Map<String, Object> map, String key, String value) {
        if (value != null) {
            map.put(key, value);
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
