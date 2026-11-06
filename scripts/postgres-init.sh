#!/bin/sh
# Creates the integration-test database next to the dev one.
# Runs only on the first initialization of the data volume; the test helper
# also creates the database on demand when it is missing.
set -e
TEST_DB="${POSTGRES_TEST_DB:-jungle_wagering_test}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<EOSQL
SELECT 'CREATE DATABASE "' || '$TEST_DB' || '"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$TEST_DB')\gexec
EOSQL
