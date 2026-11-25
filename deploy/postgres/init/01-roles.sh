#!/bin/sh
# Creates the two database roles used by core-service:
#   medimg_owner – owns the schema, runs Flyway migrations (DDL)
#   medimg_app   – used by the running application, DML only (no UPDATE/DELETE on audit_log)
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="${MEDIMG_OWNER_PASSWORD:-medimg_owner}" \
  -v app_pw="${MEDIMG_APP_PASSWORD:-medimg_app}" <<'EOSQL'
CREATE ROLE medimg_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE medimg_app   LOGIN PASSWORD :'app_pw';

SELECT format('GRANT CONNECT ON DATABASE %I TO medimg_owner, medimg_app', current_database()) \gexec

CREATE SCHEMA medimg AUTHORIZATION medimg_owner;
GRANT USAGE ON SCHEMA medimg TO medimg_app;
ALTER ROLE medimg_owner SET search_path = medimg;
ALTER ROLE medimg_app   SET search_path = medimg;

ALTER DEFAULT PRIVILEGES FOR ROLE medimg_owner IN SCHEMA medimg
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO medimg_app;
ALTER DEFAULT PRIVILEGES FOR ROLE medimg_owner IN SCHEMA medimg
  GRANT USAGE, SELECT ON SEQUENCES TO medimg_app;
ALTER DEFAULT PRIVILEGES FOR ROLE medimg_owner IN SCHEMA medimg
  GRANT EXECUTE ON FUNCTIONS TO medimg_app;
EOSQL
