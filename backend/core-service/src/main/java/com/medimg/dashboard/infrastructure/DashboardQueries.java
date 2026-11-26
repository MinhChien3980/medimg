package com.medimg.dashboard.infrastructure;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import com.medimg.dashboard.application.DashboardDtos.DailyPoint;
import com.medimg.dashboard.application.DashboardDtos.LabelCount;
import com.medimg.dashboard.application.DashboardDtos.ModelTiming;
import com.medimg.dashboard.application.DashboardDtos.RecentJob;
import com.medimg.dashboard.domain.DateRange;

/**
 * The aggregates of the dashboard, computed by PostgreSQL: every query is bounded by the range on an indexed timestamp
 * (patient.created_at, study.created_at, prediction_job.queued_at, report.created_at, finding.reviewed_at) and only
 * returns grouped rows. It reads the tables of several modules: it is a read model, it changes nothing and no module
 * depends on it. Everything of a deleted case (patient.deleted_at set) is left out.
 */
@Repository
public class DashboardQueries {

    /**
     * The row's study does not belong to a deleted case. The studies of deleted cases are few (partial index, V10):
     * PostgreSQL hashes them once and checks every row against that set, instead of joining every row with its study
     * and case. NOT IN is safe here because study.id is never null.
     */
    private static final String OF_LIVE_CASE = """
            %s NOT IN (SELECT ds.id FROM study ds JOIN patient dp ON dp.id = ds.patient_id
                       WHERE dp.deleted_at IS NOT NULL)""";

    private final NamedParameterJdbcTemplate jdbc;

    DashboardQueries(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Named parameters of every query: start, end (instants), first, last (dates) and zone. */
    public static MapSqlParameterSource params(DateRange range, ZoneId zone) {
        return new MapSqlParameterSource()
                .addValue("start", OffsetDateTime.ofInstant(range.start(zone), ZoneOffset.UTC))
                .addValue("end", OffsetDateTime.ofInstant(range.endExclusive(zone), ZoneOffset.UTC))
                .addValue("first", range.from())
                .addValue("last", range.to())
                .addValue("zone", zone.getId());
    }

    public long cases(MapSqlParameterSource p) {
        return jdbc.queryForObject("""
                SELECT count(*) FROM patient p
                WHERE p.deleted_at IS NULL AND p.created_at >= :start AND p.created_at < :end
                """, p, Long.class);
    }

    public Map<String, Long> studiesByInputType(MapSqlParameterSource p) {
        return counts("""
                SELECT s.input_type, count(*) FROM study s
                WHERE s.patient_id NOT IN (SELECT dp.id FROM patient dp WHERE dp.deleted_at IS NOT NULL)
                  AND s.created_at >= :start AND s.created_at < :end
                GROUP BY 1 ORDER BY 1
                """, p);
    }

    public Map<String, Long> jobsByStatus(MapSqlParameterSource p) {
        return counts("SELECT j.status, count(*) FROM prediction_job j WHERE "
                + OF_LIVE_CASE.formatted("j.study_id") + """
                   AND j.queued_at >= :start AND j.queued_at < :end
                GROUP BY 1 ORDER BY 1
                """, p);
    }

    public Map<String, Long> reportsByStatus(MapSqlParameterSource p) {
        return counts("SELECT r.status, count(*) FROM report r WHERE " + OF_LIVE_CASE.formatted("r.study_id") + """
                   AND r.created_at >= :start AND r.created_at < :end
                GROUP BY 1 ORDER BY 1
                """, p);
    }

    /** AI findings reviewed in the range, by review status (ACCEPTED, EDITED, REJECTED). */
    public Map<String, Long> reviewsByStatus(MapSqlParameterSource p) {
        return counts("SELECT f.review_status, count(*) FROM finding f WHERE "
                + OF_LIVE_CASE.formatted("f.study_id") + """
                   AND f.source = 'AI' AND f.reviewed_at >= :start AND f.reviewed_at < :end
                  AND f.review_status <> 'PENDING'
                GROUP BY 1 ORDER BY 1
                """, p);
    }

    /** The ten labels most often accepted or edited, the corrected label counting for an EDITED finding. */
    public List<LabelCount> topLabels(MapSqlParameterSource p) {
        return jdbc.query("SELECT coalesce(f.review_label, f.label) AS label, count(*) AS n FROM finding f WHERE "
                + OF_LIVE_CASE.formatted("f.study_id") + """
                   AND f.source = 'AI' AND f.reviewed_at >= :start AND f.reviewed_at < :end
                  AND f.review_status IN ('ACCEPTED', 'EDITED')
                GROUP BY 1 ORDER BY n DESC, label LIMIT 10
                """, p, (rs, i) -> new LabelCount(rs.getString("label"), rs.getLong("n")));
    }

    /** Per model code, over its DONE jobs queued in the range; percentiles interpolated (percentile_cont). */
    public List<ModelTiming> timings(MapSqlParameterSource p) {
        return jdbc.query("""
                SELECT m.code,
                       count(*)                                           AS jobs,
                       avg(d.ms)                                          AS avg_ms,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY d.ms)  AS p50_ms,
                       percentile_cont(0.95) WITHIN GROUP (ORDER BY d.ms) AS p95_ms,
                       avg(r.inference_ms)                                AS avg_inference_ms
                FROM (SELECT j.id, j.model_id, extract(EPOCH FROM (j.finished_at - j.queued_at)) * 1000 AS ms
                      FROM prediction_job j
                """ + " WHERE " + OF_LIVE_CASE.formatted("j.study_id") + """
                         AND j.status = 'DONE' AND j.finished_at IS NOT NULL
                        AND j.queued_at >= :start AND j.queued_at < :end) d
                         JOIN ai_model m ON m.id = d.model_id
                         LEFT JOIN prediction_result r ON r.job_id = d.id
                GROUP BY m.code ORDER BY m.code
                """, p, (rs, i) -> new ModelTiming(rs.getString("code"), rs.getLong("jobs"), round(rs, "avg_ms"),
                round(rs, "p50_ms"), round(rs, "p95_ms"), round(rs, "avg_inference_ms")));
    }

    /** Every day of the range in the zone, with zeros on days without activity. */
    public List<DailyPoint> daily(MapSqlParameterSource p) {
        return jdbc.query("""
                WITH days AS (SELECT CAST(d AS date) AS day
                              FROM generate_series(CAST(:first AS date), CAST(:last AS date), INTERVAL '1 day') d),
                     cases AS (SELECT CAST(p.created_at AT TIME ZONE :zone AS date) AS day, count(*) AS n
                               FROM patient p
                               WHERE p.deleted_at IS NULL AND p.created_at >= :start AND p.created_at < :end
                               GROUP BY 1),
                     jobs AS (SELECT CAST(j.queued_at AT TIME ZONE :zone AS date) AS day, count(*) AS n,
                                     count(*) FILTER (WHERE j.status = 'FAILED') AS failed
                              FROM prediction_job j
                """ + " WHERE " + OF_LIVE_CASE.formatted("j.study_id") + """
                                 AND j.queued_at >= :start AND j.queued_at < :end
                              GROUP BY 1)
                SELECT days.day, coalesce(cases.n, 0) AS cases, coalesce(jobs.n, 0) AS jobs,
                       coalesce(jobs.failed, 0) AS failed
                FROM days
                         LEFT JOIN cases ON cases.day = days.day
                         LEFT JOIN jobs ON jobs.day = days.day
                ORDER BY days.day
                """, p, (rs, i) -> new DailyPoint(rs.getObject("day", LocalDate.class), rs.getLong("cases"),
                rs.getLong("jobs"), rs.getLong("failed")));
    }

    /** The ten jobs queued last in the range. */
    public List<RecentJob> recentJobs(MapSqlParameterSource p) {
        return jdbc.query("""
                SELECT j.id, j.study_id, m.code, j.status, j.queued_at, j.finished_at
                FROM prediction_job j
                         JOIN ai_model m ON m.id = j.model_id
                """ + " WHERE " + OF_LIVE_CASE.formatted("j.study_id") + """
                   AND j.queued_at >= :start AND j.queued_at < :end
                ORDER BY j.queued_at DESC, j.id
                LIMIT 10
                """, p, (rs, i) -> new RecentJob(rs.getObject("id", UUID.class), rs.getObject("study_id", UUID.class),
                rs.getString("code"), rs.getString("status"), instant(rs, "queued_at"), instant(rs, "finished_at")));
    }

    private Map<String, Long> counts(String sql, MapSqlParameterSource p) {
        Map<String, Long> out = new LinkedHashMap<>();
        jdbc.query(sql, p, rs -> {
            out.put(rs.getString(1), rs.getLong(2));
        });
        return out;
    }

    private static Long round(ResultSet rs, String column) throws SQLException {
        double value = rs.getDouble(column);
        return rs.wasNull() ? null : Math.round(value);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }
}
