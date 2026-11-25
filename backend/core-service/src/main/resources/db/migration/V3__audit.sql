-- Append-only audit log, partitioned by month.
CREATE TABLE audit_log (
    id            BIGINT GENERATED ALWAYS AS IDENTITY,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id       UUID,
    username      VARCHAR(100),
    action        VARCHAR(50) NOT NULL,
    resource_type VARCHAR(50),
    resource_id   VARCHAR(64),
    outcome       VARCHAR(10),
    ip            INET,
    user_agent    TEXT,
    detail        JSONB,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX idx_audit_user ON audit_log (user_id, occurred_at);
CREATE INDEX idx_audit_resource ON audit_log (resource_type, resource_id);

-- Safety net for rows outside any monthly partition.
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

-- The application role has no DDL rights, so partitions are created through this owner-privileged function.
CREATE FUNCTION ensure_audit_partition(p_month DATE) RETURNS TEXT
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = medimg, pg_temp
AS
$$
DECLARE
    start_d DATE := date_trunc('month', p_month)::DATE;
    end_d   DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::DATE;
    part    TEXT := format('audit_log_%s', to_char(start_d, 'YYYYMM'));
BEGIN
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
                   part, start_d, end_d);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM medimg_app', part);
    RETURN part;
END;
$$;

REVOKE ALL ON FUNCTION ensure_audit_partition(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_audit_partition(DATE) TO medimg_app;

SELECT ensure_audit_partition(current_date);
SELECT ensure_audit_partition((current_date + INTERVAL '1 month')::DATE);

-- Append-only for the application.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM medimg_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log_default FROM medimg_app;
