package com.medimg.audit.application;

import java.sql.Timestamp;
import java.sql.Types;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import com.medimg.shared.audit.AuditEvent;

import tools.jackson.databind.ObjectMapper;

/** Persists audit events asynchronously so auditing never slows down or breaks the request. */
@Service
public class AuditWriter {

    private static final Logger log = LoggerFactory.getLogger(AuditWriter.class);

    private static final String INSERT = """
            INSERT INTO audit_log (occurred_at, user_id, username, action, resource_type, resource_id, outcome, ip, user_agent, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS inet), ?, CAST(? AS jsonb))
            """;

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    AuditWriter(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Async
    @EventListener
    public void on(AuditEvent e) {
        write(e);
    }

    public void write(AuditEvent e) {
        try {
            jdbc.update(INSERT, ps -> {
                ps.setTimestamp(1, Timestamp.from(e.occurredAt()));
                ps.setObject(2, e.userId(), Types.OTHER);
                ps.setString(3, e.username());
                ps.setString(4, e.action());
                ps.setString(5, e.resourceType());
                ps.setString(6, e.resourceId());
                ps.setString(7, e.outcome() == null ? null : e.outcome().name());
                ps.setString(8, e.ip());
                ps.setString(9, e.userAgent());
                ps.setString(10, json.writeValueAsString(e.detail()));
            });
        } catch (RuntimeException ex) {
            log.error("Failed to write audit event {} {}", e.action(), e.resourceId(), ex);
        }
    }
}
