-- Transactional outbox for AI job dispatch. A row is written in the same transaction as the job state change and
-- published to the Redis job streams by the relay in core-service. medimg_app gets DML on the table (and its identity
-- sequence) through the default privileges set up in deploy/postgres/init/01-roles.sh.
CREATE TABLE outbox_message (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id       UUID        NOT NULL REFERENCES prediction_job (id),
    type         VARCHAR(50) NOT NULL,
    payload      JSONB       NOT NULL,
    stream       VARCHAR(40),          -- Redis stream it was published to, chosen at publish time
    available_at TIMESTAMPTZ NOT NULL, -- not published before this instant (retry backoff, publish backoff)
    published_at TIMESTAMPTZ,
    attempts     INT         NOT NULL DEFAULT 0, -- failed publish attempts
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The relay's poll: unpublished rows by due time.
CREATE INDEX idx_outbox_message_due ON outbox_message (available_at) WHERE published_at IS NULL;

-- A job has at most one dispatch waiting to be published.
CREATE UNIQUE INDEX uq_outbox_message_pending_job ON outbox_message (job_id) WHERE published_at IS NULL;

-- The stream is chosen when the message is published and recorded on the outbox row instead.
ALTER TABLE prediction_job DROP COLUMN queue;
