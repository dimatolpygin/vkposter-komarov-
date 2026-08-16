#!/usr/bin/env bash
# Выкат на общем сервере okhost (навык /okdeploy2).
#
# Один и тот же скрипт вызывают руками на сервере и GitHub Actions при пуше в master —
# чтобы «как деплоится» было написано в одном месте, а не расползалось по yaml-у.
#
# Использование (из каталога проекта на сервере, /opt/projects/komarov-vkposter):
#   ./deploy/deploy.sh          # собрать и поднять то, что лежит в каталоге
#   ./deploy/deploy.sh --pull   # сначала подтянуть ветку деплоя с origin
#
# Отличие от схемы первого клиента: своего Postgres и своего Caddy здесь нет,
# поэтому файл всего один и проверка идёт изнутри контейнера — наружу порт не
# опубликован, `curl` с хоста в него не попадёт.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
BRANCH="${DEPLOY_BRANCH:-master}"
CONTAINER="${CONTAINER_NAME:-komarov-vkposter-app}"

log() { printf '\n=== %s\n' "$*"; }

if [ "${1:-}" = "--pull" ]; then
  log "Обновляю код из origin/$BRANCH"
  git fetch --all --quiet
  # reset --hard, а не merge: на сервере правок быть не должно, а «локальный коммит»
  # на проде однажды намертво заблокирует все следующие выкаты.
  git checkout "$BRANCH" --quiet
  git reset --hard "origin/$BRANCH" --quiet
fi

for f in .env .env.infra; do
  if [ ! -f "$f" ]; then
    echo "Нет $PROJECT_DIR/$f — выкат остановлен." >&2
    echo ".env заливается через scp (секреты не коммитятся), .env.infra создаёт okhost new." >&2
    exit 1
  fi
done

# Короткий хеш уезжает в контейнер переменной окружения и показывается в подвале
# панели. Это и есть та «видимая строка», по которой проверяется автодеплой.
APP_REVISION="$(git rev-parse --short HEAD)"
export APP_REVISION
log "Выкатываю $APP_REVISION ($(git log -1 --pretty=%s))"

docker compose up -d --build

log "Жду, пока приложение станет здоровым"
for _ in $(seq 1 60); do
  # Порт наружу не публикуется, поэтому /health дёргаем изнутри контейнера.
  if docker exec "$CONTAINER" curl -fsS --max-time 3 http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "OK: /health отвечает, версия $APP_REVISION"
    # Старые образы после пересборки остаются висеть и за пару месяцев съедают диск.
    # Общий на сервере вариант — `okhost prune`, здесь чистим только своё.
    docker image prune -f >/dev/null
    docker compose ps
    exit 0
  fi
  sleep 3
done

echo "Приложение не поднялось за 3 минуты — последние строки логов:" >&2
docker compose logs --tail 40 app >&2
exit 1
