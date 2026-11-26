package com.medimg.audit.infrastructure;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.function.Consumer;

import javax.sql.DataSource;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import com.medimg.audit.domain.AuditFilter;
import com.medimg.audit.domain.AuditRange;

/**
 * Reads the audit log. Every query is bounded by the time range on {@code occurred_at}, the partition key, so that
 * only the partitions of the range are scanned; entries are listed newest first.
 */
@Repository
public class AuditLogQueries {

    /** An entry as stored; {@code detailJson} is the JSON text of the detail. */
    public record AuditRow(long id, Instant occurredAt, UUID userId, String username, String action, String resourceType,
                           String resourceId, String outcome, String ip, String userAgent, String detailJson) {
    }

    private static final String COLUMNS = """
            id, occurred_at, user_id, username, action, resource_type, resource_id, outcome, host(ip) AS ip, user_agent,
            detail::text AS detail
            """;

    private static final RowMapper<AuditRow> ROW = AuditLogQueries::row;

    private final NamedParameterJdbcTemplate jdbc;
    /** Fetches rows in batches through a cursor (inside a transaction), so that an export does not hold them all. */
    private final NamedParameterJdbcTemplate streaming;

    AuditLogQueries(NamedParameterJdbcTemplate jdbc, DataSource dataSource) {
        this.jdbc = jdbc;
        JdbcTemplate cursor = new JdbcTemplate(dataSource);
        cursor.setFetchSize(500);
        this.streaming = new NamedParameterJdbcTemplate(cursor);
    }

    public List<AuditRow> page(AuditFilter filter, AuditRange range, int page, int size) {
        MapSqlParameterSource p = params(filter, range).addValue("limit", size).addValue("offset", (long) page * size);
        return jdbc.query("SELECT " + COLUMNS + " FROM audit_log " + where(filter)
                + " ORDER BY occurred_at DESC, id DESC LIMIT :limit OFFSET :offset", p, ROW);
    }

    public long count(AuditFilter filter, AuditRange range) {
        return jdbc.queryForObject("SELECT count(*) FROM audit_log " + where(filter), params(filter, range), Long.class);
    }

    /** The actions recorded in the range, alphabetically. */
    public List<String> actions(AuditRange range) {
        return jdbc.queryForList("SELECT DISTINCT action FROM audit_log " + where(AuditFilter.NONE) + " ORDER BY action",
                params(AuditFilter.NONE, range), String.class);
    }

    /** Hands the matching entries, newest first and at most {@code limit}, one by one to {@code sink}. */
    public void stream(AuditFilter filter, AuditRange range, int limit, Consumer<AuditRow> sink) {
        MapSqlParameterSource p = params(filter, range).addValue("limit", limit);
        streaming.query("SELECT " + COLUMNS + " FROM audit_log " + where(filter)
                + " ORDER BY occurred_at DESC, id DESC LIMIT :limit", p, rs -> {
                    sink.accept(row(rs, 0));
                });
    }

    private static String where(AuditFilter f) {
        StringBuilder sql = new StringBuilder("WHERE occurred_at >= :from AND occurred_at < :to");
        if (f.userId() != null) {
            sql.append(" AND user_id = :userId");
        }
        if (f.username() != null) {
            sql.append(" AND lower(username) LIKE :username ESCAPE '!'");
        }
        if (f.action() != null) {
            sql.append(" AND action = :action");
        }
        if (f.entityType() != null) {
            sql.append(" AND resource_type = :entityType");
        }
        if (f.entityId() != null) {
            sql.append(" AND resource_id = :entityId");
        }
        if (f.outcome() != null) {
            sql.append(" AND outcome = :outcome");
        }
        return sql.toString();
    }

    private static MapSqlParameterSource params(AuditFilter f, AuditRange range) {
        return new MapSqlParameterSource()
                .addValue("from", OffsetDateTime.ofInstant(range.from(), ZoneOffset.UTC))
                .addValue("to", OffsetDateTime.ofInstant(range.to(), ZoneOffset.UTC))
                .addValue("userId", f.userId())
                .addValue("username", f.username() == null ? null : "%" + f.username().toLowerCase(Locale.ROOT)
                        .replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%")
                .addValue("action", f.action())
                .addValue("entityType", f.entityType())
                .addValue("entityId", f.entityId())
                .addValue("outcome", f.outcome());
    }

    private static AuditRow row(ResultSet rs, int i) throws SQLException {
        return new AuditRow(rs.getLong("id"), rs.getObject("occurred_at", OffsetDateTime.class).toInstant(),
                rs.getObject("user_id", UUID.class), rs.getString("username"), rs.getString("action"),
                rs.getString("resource_type"), rs.getString("resource_id"), rs.getString("outcome"), rs.getString("ip"),
                rs.getString("user_agent"), rs.getString("detail"));
    }
}
