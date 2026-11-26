package com.medimg.dashboard.application;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The dashboard: aggregates only, no data that identifies a patient. Every figure counts what happened in the range
 * (cases and studies created, jobs queued, reports created, findings reviewed), cases deleted since and everything
 * belonging to them left out. Map keys with a zero count are omitted.
 */
public final class DashboardDtos {

    private DashboardDtos() {
    }

    public record DashboardDto(LocalDate from, LocalDate to, String zone, Totals totals, Processing processing,
                               Review review, List<LabelCount> labels, List<DailyPoint> daily,
                               List<RecentJob> recentJobs) {
    }

    public record Totals(long cases, long studies, Map<String, Long> studiesByInputType, long jobs,
                         Map<String, Long> jobsByStatus, ReportCounts reports) {
    }

    /** Reports created in the range, by their current status. */
    public record ReportCounts(long draft, @JsonProperty("final") long finalCount) {
    }

    public record Processing(List<ModelTiming> perModel) {
    }

    /**
     * Over the DONE jobs of the model queued in the range: {@code jobs} is their number, the times are from queued to
     * finished (of the last attempt, a retry queues the job again) and the inference time reported by the worker.
     */
    public record ModelTiming(String modelCode, long jobs, Long avgMs, Long p50Ms, Long p95Ms, Long avgInferenceMs) {
    }

    /**
     * Reviews of AI findings made in the range (findings added by hand are accepted by definition and left out).
     * {@code acceptanceRate} = (accepted + edited) / reviewed, null when nothing was reviewed.
     */
    public record Review(long reviewed, long accepted, long edited, long rejected, Double acceptanceRate) {
    }

    /** An AI finding label (the corrected one of an EDITED finding, as the report states it) and how often it was kept. */
    public record LabelCount(String label, long accepted) {
    }

    /** One day of the range in the dashboard time zone; days without activity are present with zeros. */
    public record DailyPoint(LocalDate date, long cases, long jobs, long failedJobs) {
    }

    public record RecentJob(UUID jobId, UUID studyId, String modelCode, String status, Instant queuedAt,
                            Instant finishedAt) {
    }
}
