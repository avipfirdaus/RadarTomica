#!/usr/bin/env bash
# Backup harian Postgres Radar Tomica (disimpan terkompresi, retensi 14 hari).
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/RadarTomica}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
OUT_FILE="$BACKUP_DIR/radar-$STAMP.sql.gz"

cd "$APP_DIR"
docker compose exec -T db pg_dump -U radar -d radar --no-owner --no-acl | gzip -9 > "$OUT_FILE"
chmod 600 "$OUT_FILE"

find "$BACKUP_DIR" -type f -name 'radar-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "[backup-db] OK: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
