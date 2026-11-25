-- CT volumes (ingest by the Python worker) and 3D segmentation results.

-- Outbox shared by the modules ------------------------------------------------
-- A row now dispatches either an AI job (JOB_DISPATCH) or the ingest of a volume upload (INGEST_DISPATCH), so it
-- names its aggregate instead of referencing prediction_job.
ALTER TABLE outbox_message DROP CONSTRAINT outbox_message_job_id_fkey;
ALTER TABLE outbox_message RENAME COLUMN job_id TO aggregate_id;
DROP INDEX uq_outbox_message_pending_job;
CREATE UNIQUE INDEX uq_outbox_message_pending ON outbox_message (type, aggregate_id) WHERE published_at IS NULL;

-- The payload is now the stream entry itself (field name → value). Dispatches not yet published are rewritten from
-- the former job message shape; published rows are never read again.
UPDATE outbox_message
SET payload = jsonb_build_object(
        'jobId', payload ->> 'jobId',
        'attempt', payload ->> 'attempt',
        'modelCode', payload ->> 'modelCode',
        'modelVersion', payload ->> 'modelVersion',
        'task', payload ->> 'task',
        'inputType', payload ->> 'inputType',
        'inputUri', payload ->> 'inputUri',
        'outputPrefix', payload ->> 'outputPrefix',
        'params', payload ->> 'paramsJson')
WHERE type = 'JOB_DISPATCH' AND published_at IS NULL;

-- Imaging ----------------------------------------------------------------------
ALTER TABLE upload_session
    ADD COLUMN input_type         VARCHAR(20),                 -- detected from the file content at complete
    ADD COLUMN progress           SMALLINT NOT NULL DEFAULT 0, -- 0-100
    ADD COLUMN attempt            SMALLINT NOT NULL DEFAULT 1, -- ingest attempt of a volume upload
    -- A volume is written by the ingest worker under studies/{reserved_study_id}/series/{reserved_series_id}/; the
    -- study and series rows are created with these ids once it is done.
    ADD COLUMN reserved_study_id  UUID,
    ADD COLUMN reserved_series_id UUID,
    ADD COLUMN version            BIGINT NOT NULL DEFAULT 0;

-- Every upload processed so far was a 2D image.
UPDATE upload_session SET input_type = 'IMAGE_2D' WHERE status <> 'INIT';
UPDATE upload_session SET progress = 100 WHERE status = 'DONE';

-- Voxel spacing of a volume in mm. Its dimensions are cols (x), rows (y) and num_images (z).
ALTER TABLE series
    ADD COLUMN spacing_x DOUBLE PRECISION,
    ADD COLUMN spacing_y DOUBLE PRECISION,
    ADD COLUMN spacing_z DOUBLE PRECISION,
    ADD CONSTRAINT ck_series_spacing CHECK (num_nonnulls(spacing_x, spacing_y, spacing_z) IN (0, 3));

-- Prediction -------------------------------------------------------------------
ALTER TABLE prediction_result
    ADD COLUMN segmentation_key TEXT,  -- bucket-relative key of the labelmap (segmentation.nii.gz)
    ADD COLUMN meshes           JSONB; -- [{label, color, key, triangles, volumeMl, centroid}]

ALTER TABLE finding ADD COLUMN volume_ml NUMERIC(10, 2); -- segmented volume; confidence is NULL for segmentation

-- ai_model.modality is a comma separated list like input_types; chest X-rays come as CR or DX.
UPDATE ai_model SET modality = 'CR,DX' WHERE code = 'cxr-multilabel' AND version = '0.1.0-xrv';

-- TotalSegmentator 2.18.0 (--fast), classes merged into 21 labels; label i is voxel value i of the labelmap.
INSERT INTO ai_model (id, code, version, name, task, input_types, modality, body_part, labels, status)
VALUES ('6f9a3c1e-0b1d-4c55-9a51-7c2f1e0a0002', 'ct-totalseg', '2.18.0-fast',
        'CT organ segmentation (TotalSegmentator 2.18.0, fast)', 'SEGMENTATION_3D',
        'NIFTI,DICOM_SERIES', 'CT', NULL,
        '["liver","spleen","kidney_left","kidney_right","pancreas","stomach","gallbladder","urinary_bladder","lung_left","lung_right","heart","aorta","esophagus","trachea","colon","small_bowel","spine","ribs","hip","femur","adrenal_glands"]',
        'ACTIVE');
