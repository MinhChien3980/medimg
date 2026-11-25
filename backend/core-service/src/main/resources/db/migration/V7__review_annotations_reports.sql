-- Review of AI findings and findings added by hand, annotations, and reports.

-- Imaging ----------------------------------------------------------------------
-- A 2D image may now have a pixel spacing (mm, from the DICOM header): spacing_x and spacing_y without spacing_z.
-- A volume still has all three.
ALTER TABLE series
    DROP CONSTRAINT ck_series_spacing,
    ADD CONSTRAINT ck_series_spacing CHECK (
        num_nonnulls(spacing_x, spacing_y) IN (0, 2) AND (spacing_z IS NULL OR spacing_x IS NOT NULL));

-- Annotations ------------------------------------------------------------------
-- geometry is in image pixels (origin top-left, x right, y down) on a 2D image, in patient LPS mm on a volume;
-- measurement holds the values computed by the client and checked by core-service.
CREATE TABLE annotation (
    id          UUID PRIMARY KEY,
    study_id    UUID          NOT NULL REFERENCES study (id),
    series_id   UUID          NOT NULL REFERENCES series (id),
    author_id   UUID          NOT NULL,
    kind        VARCHAR(20)   NOT NULL,
    geometry    JSONB         NOT NULL,
    label       VARCHAR(100),
    note        VARCHAR(1000),
    measurement JSONB,
    created_at  TIMESTAMPTZ   NOT NULL,
    updated_at  TIMESTAMPTZ   NOT NULL,
    version     BIGINT        NOT NULL DEFAULT 0,
    CONSTRAINT ck_annotation_kind CHECK (
        kind IN ('RECTANGLE', 'POLYGON', 'ARROW', 'LENGTH', 'RECTANGLE_ROI', 'ELLIPSE_ROI'))
);
CREATE INDEX idx_annotation_study ON annotation (study_id, created_at);

-- Findings ---------------------------------------------------------------------
-- A finding comes from an AI result (source AI, result_id set) or is added by a doctor (source MANUAL, no result,
-- accepted when added, the doctor being its reviewer). Every finding names its study and series, so the findings of a
-- study are read without going through the jobs.
ALTER TABLE finding
    ADD COLUMN source        VARCHAR(10),
    ADD COLUMN study_id      UUID REFERENCES study (id),
    ADD COLUMN series_id     UUID REFERENCES series (id),
    ADD COLUMN review_label  VARCHAR(100), -- the corrected label of an EDITED finding
    ADD COLUMN review_note   VARCHAR(1000),
    ADD COLUMN reviewed_by   UUID,
    ADD COLUMN reviewed_at   TIMESTAMPTZ,
    ADD COLUMN annotation_id UUID REFERENCES annotation (id) ON DELETE SET NULL, -- the shape a manual finding points at
    ADD COLUMN version       BIGINT NOT NULL DEFAULT 0,
    ALTER COLUMN result_id DROP NOT NULL;

UPDATE finding f
SET source = 'AI', study_id = j.study_id, series_id = j.series_id
FROM prediction_result r
         JOIN prediction_job j ON j.id = r.job_id
WHERE r.id = f.result_id;

ALTER TABLE finding
    ALTER COLUMN source SET NOT NULL,
    ALTER COLUMN study_id SET NOT NULL,
    ALTER COLUMN series_id SET NOT NULL,
    ADD CONSTRAINT ck_finding_review_status CHECK (review_status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EDITED')),
    ADD CONSTRAINT ck_finding_source CHECK (CASE source
        WHEN 'AI' THEN result_id IS NOT NULL AND annotation_id IS NULL
        WHEN 'MANUAL' THEN result_id IS NULL AND confidence IS NULL AND volume_ml IS NULL AND bbox IS NULL
            AND review_status = 'ACCEPTED'
        END),
    ADD CONSTRAINT ck_finding_reviewed CHECK (
        (review_status = 'PENDING') = (reviewed_by IS NULL)
        AND num_nonnulls(reviewed_by, reviewed_at) IN (0, 2)
        AND (reviewed_by IS NOT NULL OR review_note IS NULL)),
    ADD CONSTRAINT ck_finding_review_label CHECK ((review_status = 'EDITED') = (review_label IS NOT NULL));

CREATE INDEX idx_finding_study ON finding (study_id);
-- The status alone is never queried.
DROP INDEX idx_finding_review;

-- Reports ----------------------------------------------------------------------
-- The reports of a study are versions 1, 2, ...: version 1 is written from scratch, every later one amends the final
-- version before it. A study has at most one draft at a time. A final report never changes (enforced below).
CREATE TABLE report (
    id               UUID PRIMARY KEY,
    study_id         UUID           NOT NULL REFERENCES study (id),
    version          INT            NOT NULL,
    status           VARCHAR(10)    NOT NULL,
    template         VARCHAR(10)    NOT NULL,
    language         VARCHAR(2)     NOT NULL,
    clinical_info    VARCHAR(2000),
    technique        VARCHAR(4000),
    findings_text    VARCHAR(10000),
    impression       VARCHAR(4000),
    author_id        UUID           NOT NULL,
    signed_by        UUID,
    signed_at        TIMESTAMPTZ,
    amends_report_id UUID REFERENCES report (id),
    pdf_key          TEXT,
    created_at       TIMESTAMPTZ    NOT NULL,
    updated_at       TIMESTAMPTZ    NOT NULL,
    row_version      BIGINT         NOT NULL DEFAULT 0,
    CONSTRAINT uq_report_study_version UNIQUE (study_id, version),
    CONSTRAINT ck_report_version CHECK (version > 0 AND (version = 1) = (amends_report_id IS NULL)),
    CONSTRAINT ck_report_status CHECK (status IN ('DRAFT', 'FINAL')),
    CONSTRAINT ck_report_template CHECK (template IN ('CXR', 'CT')),
    CONSTRAINT ck_report_language CHECK (language IN ('vi', 'en')),
    CONSTRAINT ck_report_signed CHECK (
        (status = 'FINAL') = (signed_by IS NOT NULL)
        AND num_nonnulls(signed_by, signed_at, pdf_key) IN (0, 3))
);
CREATE UNIQUE INDEX uq_report_draft ON report (study_id) WHERE status = 'DRAFT';

-- Key images of a report, in position order; uploaded_at is set once the PNG has been uploaded and checked.
CREATE TABLE report_key_image (
    id          UUID PRIMARY KEY,
    report_id   UUID         NOT NULL REFERENCES report (id) ON DELETE CASCADE,
    object_key  TEXT         NOT NULL,
    caption     VARCHAR(200),
    position    SMALLINT     NOT NULL,
    uploaded_at TIMESTAMPTZ,
    -- deferred: reordering swaps positions within one transaction
    CONSTRAINT uq_report_key_image_position UNIQUE (report_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- The findings a final report was signed with. A cited finding cannot be deleted.
CREATE TABLE report_finding (
    report_id  UUID NOT NULL REFERENCES report (id),
    finding_id UUID NOT NULL REFERENCES finding (id),
    PRIMARY KEY (report_id, finding_id)
);
CREATE INDEX idx_report_finding_finding ON report_finding (finding_id);

-- A final report and its key images are immutable; a correction is a new version that amends it.
CREATE FUNCTION reject_final_report_change() RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = medimg, pg_temp
AS
$$
DECLARE
    target UUID;
BEGIN
    -- separate statements: a record field is only resolved when its statement runs
    IF TG_TABLE_NAME = 'report' THEN
        target := OLD.id;
    ELSIF TG_OP = 'INSERT' THEN
        target := NEW.report_id;
    ELSE
        target := OLD.report_id;
    END IF;
    IF EXISTS (SELECT 1 FROM report WHERE id = target AND status = 'FINAL') THEN
        RAISE EXCEPTION 'report % is final and cannot be changed', target USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_report_final_immutable
    BEFORE UPDATE OR DELETE ON report
    FOR EACH ROW EXECUTE FUNCTION reject_final_report_change();

CREATE TRIGGER trg_report_key_image_final_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON report_key_image
    FOR EACH ROW EXECUTE FUNCTION reject_final_report_change();
