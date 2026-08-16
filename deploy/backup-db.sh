#!/usr/bin/env bash
# Ночной бэкап базы: pg_dump внутрь контейнера, gzip, хранение 14 дней.
# Ставится в cron скриптом scripts/install.sh (/etc/cron.d/vkposter-backup).
set -Eeuo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-/opt/vkposter/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

# Логин и имя базы берём из .env — они же у контейнера postgres.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y-%m-%d_%H%M)"
FILE="$BACKUP_DIR/vkposter_$STAMP.sql.gz"

# -T обязателен: cron запускается без tty, а docker compose exec без него падает.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip -9 > "$FILE.part"

# Переименование в конце: оборванный дамп не должен выглядеть готовым бэкапом.
mv "$FILE.part" "$FILE"
find "$BACKUP_DIR" -name 'vkposter_*.sql.gz' -mtime +"$KEEP_DAYS" -delete

echo "$(date '+%d.%m.%Y %H:%M') бэкап готов: $FILE ($(du -h "$FILE" | cut -f1))"
