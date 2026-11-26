-- Substring search on case code and note (GET /patients?q=) without scanning the whole table.
-- pg_trgm is installed by the database init (deploy/postgres/init); on an existing database a superuser runs
-- "CREATE EXTENSION pg_trgm SCHEMA medimg" once. The statement below is then a no-op.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA medimg;

-- The expressions must stay those of PatientRepository.SEARCH, or the planner cannot use the indexes.
CREATE INDEX idx_patient_code_trgm ON patient USING gin (lower(code) gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX idx_patient_note_trgm ON patient USING gin (lower(coalesce(note, '')) gin_trgm_ops) WHERE deleted_at IS NULL;
