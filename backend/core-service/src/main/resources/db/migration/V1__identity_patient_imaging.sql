-- Identity ---------------------------------------------------------------
CREATE TABLE app_user (
    id            UUID PRIMARY KEY,
    username      VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    full_name     VARCHAR(200),
    email         VARCHAR(200),
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE user_role (
    user_id   UUID        NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    role_code VARCHAR(30) NOT NULL,
    PRIMARY KEY (user_id, role_code)
);

CREATE TABLE refresh_token (
    id         UUID PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    token_hash CHAR(64)    NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_token_user ON refresh_token (user_id);

-- Patient ----------------------------------------------------------------
CREATE TABLE patient (
    id            UUID PRIMARY KEY,
    code          VARCHAR(32)  NOT NULL UNIQUE,
    birth_year    SMALLINT,
    sex           CHAR(1),
    note          VARCHAR(500),
    is_anonymized BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by    UUID,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ,
    deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_patient_created ON patient (created_at DESC) WHERE deleted_at IS NULL;

-- Imaging ----------------------------------------------------------------
CREATE TABLE study (
    id             UUID PRIMARY KEY,
    patient_id     UUID        NOT NULL REFERENCES patient (id),
    input_type     VARCHAR(20) NOT NULL, -- IMAGE_2D, DICOM_2D, DICOM_SERIES, NIFTI, IMAGE_STACK
    modality       VARCHAR(10),
    body_part      VARCHAR(30),
    storage_prefix TEXT,
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_study_patient ON study (patient_id, created_at DESC);

CREATE TABLE series (
    id            UUID PRIMARY KEY,
    study_id      UUID        NOT NULL REFERENCES study (id),
    modality      VARCHAR(10),
    num_images    INT,
    rows          INT,
    cols          INT,
    volume_uri    TEXT,
    thumbnail_uri TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_series_study ON series (study_id);

CREATE TABLE image_file (
    id              UUID PRIMARY KEY,
    series_id       UUID NOT NULL REFERENCES series (id),
    original_name   VARCHAR(255),
    content_type    VARCHAR(100),
    size_bytes      BIGINT,
    sha256          CHAR(64),
    storage_uri     TEXT,
    instance_number INT
);
CREATE INDEX idx_image_file_series ON image_file (series_id);

CREATE TABLE upload_session (
    id             UUID PRIMARY KEY,
    patient_id     UUID        NOT NULL REFERENCES patient (id),
    status         VARCHAR(20) NOT NULL, -- INIT, UPLOADED, PROCESSING, DONE, FAILED
    modality_hint  VARCHAR(10),
    body_part_hint VARCHAR(30),
    file_count     INT         NOT NULL,
    total_bytes    BIGINT      NOT NULL,
    study_id       UUID REFERENCES study (id),
    error          TEXT,
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ
);

CREATE TABLE upload_file (
    id           UUID PRIMARY KEY,
    upload_id    UUID         NOT NULL REFERENCES upload_session (id) ON DELETE CASCADE,
    name         VARCHAR(255) NOT NULL,
    size_bytes   BIGINT       NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    storage_key  TEXT         NOT NULL
);
CREATE INDEX idx_upload_file_upload ON upload_file (upload_id);
