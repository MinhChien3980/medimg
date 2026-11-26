package com.medimg.prediction.infrastructure;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Usage statistics of the models, aggregated in the database (one row per model, no job loaded into memory). */
@Repository
public class ModelUsageQueries {

    /** All jobs of a model, whatever their case; times of DONE jobs only. {@code null} averages when none is DONE. */
    public record ModelUsage(long jobs, long done, long failed, Double avgInferenceMs, Double p95InferenceMs,
                             OffsetDateTime lastUsedAt) {

        public static final ModelUsage NONE = new ModelUsage(0, 0, 0, null, null, null);
    }

    private static final String SQL = """
            SELECT j.model_id,
                   count(*)                                                  AS jobs,
                   count(*) FILTER (WHERE j.status = 'DONE')                 AS done,
                   count(*) FILTER (WHERE j.status = 'FAILED')               AS failed,
                   avg(r.inference_ms) FILTER (WHERE j.status = 'DONE')      AS avg_ms,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY r.inference_ms)
                       FILTER (WHERE j.status = 'DONE')                      AS p95_ms,
                   max(j.queued_at)                                          AS last_used
            FROM prediction_job j
                     LEFT JOIN prediction_result r ON r.job_id = j.id
            GROUP BY j.model_id
            """;

    private final JdbcTemplate jdbc;

    ModelUsageQueries(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Usage of every model that has had a job. */
    public Map<UUID, ModelUsage> usageByModel() {
        Map<UUID, ModelUsage> out = new HashMap<>();
        jdbc.query(SQL, rs -> {
            out.put(rs.getObject("model_id", UUID.class), usage(rs));
        });
        return out;
    }

    private static ModelUsage usage(ResultSet rs) throws SQLException {
        return new ModelUsage(rs.getLong("jobs"), rs.getLong("done"), rs.getLong("failed"),
                nullableDouble(rs, "avg_ms"), nullableDouble(rs, "p95_ms"),
                rs.getObject("last_used", OffsetDateTime.class));
    }

    private static Double nullableDouble(ResultSet rs, String column) throws SQLException {
        double value = rs.getDouble(column);
        return rs.wasNull() ? null : value;
    }
}
