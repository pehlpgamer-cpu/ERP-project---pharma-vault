#!/bin/sh
# Runs once, on the first start of the development MySQL container (see compose.dev.yaml): creates the
# empty test database that `npm test` uses and loads the schema into it, next to the development one.
set -eu

mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS \`pharma_vault_test\` CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON \`pharma_vault_test\`.* TO '$MYSQL_USER'@'%';
SQL

mysql -uroot -p"$MYSQL_ROOT_PASSWORD" pharma_vault_test < /docker-entrypoint-initdb.d/01-schema.sql
