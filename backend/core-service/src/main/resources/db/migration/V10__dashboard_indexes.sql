-- Dashboard queries (DashboardQueries) on a year of data.

-- Deleted cases are few: the dashboard leaves out their rows by checking against this small set instead of joining every
-- row with its study and case.
CREATE INDEX idx_patient_deleted ON patient (id) WHERE deleted_at IS NOT NULL;

-- Job and review figures are read from the index alone (index-only scan), without visiting the table rows.
DROP INDEX idx_prediction_job_queued;
CREATE INDEX idx_prediction_job_queued ON prediction_job (queued_at) INCLUDE (study_id, status, model_id, finished_at);

DROP INDEX idx_finding_ai_reviewed;
CREATE INDEX idx_finding_ai_reviewed ON finding (reviewed_at) INCLUDE (study_id, review_status, label, review_label)
    WHERE source = 'AI' AND reviewed_at IS NOT NULL;
