-- DICOM X-rays and stacks of 2D images, multipart uploads and sample cases.

-- Imaging ----------------------------------------------------------------------
-- What the ingest worker is asked to read (DICOM_2D, ZIP, NIFTI), set at complete. A ZIP holds either a DICOM series
-- or a stack of 2D images and the worker tells which, so input_type of such an upload stays NULL until it is done.
-- spacing_* is the voxel spacing in mm given at init for a stack of 2D images.
ALTER TABLE upload_session
    ADD COLUMN ingest_input VARCHAR(10),
    ADD COLUMN spacing_x    DOUBLE PRECISION,
    ADD COLUMN spacing_y    DOUBLE PRECISION,
    ADD COLUMN spacing_z    DOUBLE PRECISION,
    ADD CONSTRAINT ck_upload_session_spacing CHECK (num_nonnulls(spacing_x, spacing_y, spacing_z) IN (0, 3));

UPDATE upload_session SET ingest_input = 'ZIP' WHERE input_type = 'DICOM_SERIES';
UPDATE upload_session SET ingest_input = 'NIFTI' WHERE input_type = 'NIFTI';

-- A file above the multipart threshold is uploaded in parts; the multipart upload is completed or aborted by core.
ALTER TABLE upload_file
    ADD COLUMN multipart_upload_id VARCHAR(1024),
    ADD COLUMN part_count          INT,
    ADD CONSTRAINT ck_upload_file_multipart CHECK (num_nonnulls(multipart_upload_id, part_count) IN (0, 2));

-- True when the slice spacing of a stack of 2D images was not given and 1 mm was assumed.
ALTER TABLE series ADD COLUMN spacing_assumed BOOLEAN NOT NULL DEFAULT FALSE;

-- Patient ----------------------------------------------------------------------
-- A case is a sample case when it has a sample title; the source names where the images come from and their license.
ALTER TABLE patient
    ADD COLUMN sample_title       VARCHAR(120),
    ADD COLUMN sample_description VARCHAR(500),
    ADD COLUMN sample_source      VARCHAR(300),
    ADD CONSTRAINT ck_patient_sample CHECK (
        num_nonnulls(sample_title, sample_source) IN (0, 2)
        AND (sample_title IS NOT NULL OR sample_description IS NULL));
