-- User administration (lock, password reset and change), model enable/disable, dashboard and audit log queries.

-- Identity ---------------------------------------------------------------------
-- A LOCKED user cannot log in, refresh or use an access token. password_change_required is set on an account created
-- by an admin or whose password an admin reset (it then holds a temporary password); every API except /me,
-- /me/password and /auth/* is refused until the user sets a password of their own. version is the optimistic lock
-- of the admin forms; logins do not change it.
ALTER TABLE app_user
    ADD COLUMN status                   VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN locked_at                TIMESTAMPTZ,
    ADD COLUMN locked_by                UUID,
    ADD COLUMN password_change_required BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN password_changed_at      TIMESTAMPTZ,
    ADD COLUMN version                  BIGINT      NOT NULL DEFAULT 0,
    ADD CONSTRAINT ck_app_user_status CHECK (status IN ('ACTIVE', 'LOCKED')),
    ADD CONSTRAINT ck_app_user_locked CHECK ((status = 'LOCKED') = (locked_at IS NOT NULL)
        AND (locked_by IS NULL OR locked_at IS NOT NULL));

-- Usernames are unique regardless of case (the application stores them in lower case).
CREATE UNIQUE INDEX uq_app_user_username_lower ON app_user (lower(username));

-- Why a refresh token was revoked. Only a ROTATED token presented again is a sign of theft (every session of the user
-- is then revoked); a token revoked by logout, lock, password reset or change is simply refused. NULL for tokens
-- revoked before this migration, treated as ROTATED.
ALTER TABLE refresh_token
    ADD COLUMN revoked_reason VARCHAR(20),
    ADD CONSTRAINT ck_refresh_token_revoked_reason CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL);

-- Prediction -------------------------------------------------------------------
-- An admin can disable an ACTIVE model and enable it again: a DISABLED model is not offered and takes no new job.
ALTER TABLE ai_model
    ADD CONSTRAINT ck_ai_model_status CHECK (status IN ('STAGING', 'ACTIVE', 'RETIRED', 'DISABLED'));

-- Dashboard: every aggregate is bounded by a time range on these columns -----------------------------------------
-- (patient.created_at is covered by idx_patient_created, prediction_job by idx_prediction_job_queued below)
CREATE INDEX idx_study_created ON study (created_at);
CREATE INDEX idx_prediction_job_queued ON prediction_job (queued_at);
CREATE INDEX idx_prediction_job_model ON prediction_job (model_id, queued_at);
CREATE INDEX idx_report_created ON report (created_at);
CREATE INDEX idx_finding_ai_reviewed ON finding (reviewed_at) WHERE source = 'AI' AND reviewed_at IS NOT NULL;

-- Audit log --------------------------------------------------------------------
-- The admin view lists a time range (at most 93 days, i.e. a few monthly partitions) newest first, optionally by
-- action. Indexes on the partitioned table are created on every partition, present and future.
CREATE INDEX idx_audit_occurred ON audit_log (occurred_at DESC, id DESC);
CREATE INDEX idx_audit_action ON audit_log (action, occurred_at DESC);
