CREATE TABLE ai_model (
    id           UUID PRIMARY KEY,
    code         VARCHAR(50)  NOT NULL,
    version      VARCHAR(20)  NOT NULL,
    name         VARCHAR(200),
    task         VARCHAR(30)  NOT NULL, -- CLASSIFICATION_2D, DETECTION_2D, SEGMENTATION_3D
    input_types  VARCHAR(100) NOT NULL, -- comma separated, e.g. IMAGE_2D,DICOM_2D
    modality     VARCHAR(10),
    body_part    VARCHAR(30),
    labels       JSONB,
    status       VARCHAR(20)  NOT NULL, -- STAGING, ACTIVE, RETIRED
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (code, version)
);

CREATE TABLE prediction_job (
    id              UUID PRIMARY KEY,
    study_id        UUID        NOT NULL REFERENCES study (id),
    series_id       UUID        NOT NULL REFERENCES series (id),
    model_id        UUID        NOT NULL REFERENCES ai_model (id),
    status          VARCHAR(20) NOT NULL, -- QUEUED, RUNNING, DONE, FAILED, CANCELLED
    queue           VARCHAR(40),
    progress        SMALLINT    NOT NULL DEFAULT 0,
    attempt         SMALLINT    NOT NULL DEFAULT 1,
    params          JSONB,
    idempotency_key VARCHAR(64),
    worker_id       VARCHAR(100),
    requested_by    UUID,
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    error_message   TEXT,
    version         BIGINT      NOT NULL DEFAULT 0,
    UNIQUE (requested_by, idempotency_key)
);
CREATE INDEX idx_prediction_job_status ON prediction_job (status, queued_at);
CREATE INDEX idx_prediction_job_study ON prediction_job (study_id, queued_at DESC);

CREATE TABLE prediction_result (
    id           UUID PRIMARY KEY,
    job_id       UUID NOT NULL UNIQUE REFERENCES prediction_job (id),
    summary      JSONB,
    heatmaps     JSONB, -- label -> bucket-relative key of the heatmap PNG
    inference_ms INT
);

CREATE TABLE finding (
    id            UUID PRIMARY KEY,
    result_id     UUID         NOT NULL REFERENCES prediction_result (id),
    label         VARCHAR(100) NOT NULL,
    confidence    NUMERIC(5, 4),
    bbox          JSONB,
    review_status VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
);
CREATE INDEX idx_finding_result ON finding (result_id);
CREATE INDEX idx_finding_review ON finding (review_status);

-- Baseline model: TorchXRayVision DenseNet-121 (res224, "all" weights), pretrained – not yet fine-tuned.
INSERT INTO ai_model (id, code, version, name, task, input_types, modality, body_part, labels, status)
VALUES ('6f9a3c1e-0b1d-4c55-9a51-7c2f1e0a0001', 'cxr-multilabel', '0.1.0-xrv',
        'Chest X-ray multi-label (TorchXRayVision DenseNet-121 baseline)', 'CLASSIFICATION_2D',
        'IMAGE_2D,DICOM_2D', 'CR', 'CHEST',
        '["Atelectasis","Consolidation","Infiltration","Pneumothorax","Edema","Emphysema","Fibrosis","Effusion","Pneumonia","Pleural_Thickening","Cardiomegaly","Nodule","Mass","Hernia","Lung Lesion","Fracture","Lung Opacity","Enlarged Cardiomediastinum"]',
        'ACTIVE');
