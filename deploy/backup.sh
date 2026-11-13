#!/bin/sh
# Daily logical backup of the Pharma Vault database, run by the `backup` service in compose.prod.yaml.
# Dumps run once a minute after start-up and then every 24 hours; files older than BACKUP_KEEP_DAYS
# are deleted. Restore: see docs/DEPLOYMENT.md.
set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

while true; do
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  file="/backups/pharma-vault-${stamp}.sql.gz"

  if mysqldump --host="$MYSQL_HOST" --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" \
      --single-transaction --routines --no-tablespaces --default-character-set=utf8mb4 \
      "$MYSQL_DATABASE" | gzip > "${file}.partial"; then
    mv "${file}.partial" "$file"
    echo "backup written: $file"
  else
    rm -f "${file}.partial"
    echo "backup FAILED at $stamp" >&2
  fi

  find /backups -name 'pharma-vault-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
  sleep 86400
done
