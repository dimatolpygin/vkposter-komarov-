#!/usr/bin/env bash
# Выкат текущего состояния рабочего каталога на проде.
#
# Один и тот же скрипт вызывают install.sh (первый запуск) и GitHub Actions
# (каждый пуш в master) — чтобы «как деплоится» было написано в одном месте
# и не расползалось по yaml-у workflow.
#
# Использование (из каталога проекта на сервере):
#   ./deploy/deploy.sh          # собрать и поднять то, что лежит в каталоге
#   ./deploy/deploy.sh --pull   # сначала подтянуть ветку деплоя с origin
set -Eeuo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
BRANCH="${DEPLOY_BRANCH:-master}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

log() { printf '\n=== %s\n' "$*"; }

if [ "${1:-}" = "--pull" ]; then
  log "Обновляю код из origin/$BRANCH"
  git fetch --all --quiet
  # reset --hard, а не merge: на сервере правок быть не должно, а «локальный коммит»
  # на проде однажды намертво заблокирует все следующие выкаты.
  git checkout "$BRANCH" --quiet
  git reset --hard "origin/$BRANCH" --quiet
fi

if [ ! -f .env ]; then
  echo "Нет $PROJECT_DIR/.env — выкат остановлен (секреты на сервер не коммитятся)" >&2
  exit 1
fi

# Короткий хеш уезжает в контейнер переменной окружения и показывается в подвале
# панели. Это и есть та «видимая строка», по которой проверяется автодеплой.
APP_REVISION="$(git rev-parse --short HEAD)"
export APP_REVISION
log "Выкатываю $APP_REVISION ($(git log -1 --pretty=%s))"

"${COMPOSE[@]}" up -d --build

log "Жду, пока приложение станет здоровым"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 3 http://127.0.0.1:"${APP_PORT:-3000}"/health >/dev/null 2>&1; then
    echo "OK: /health отвечает, версия $APP_REVISION"
    # Старые образы после пересборки остаются висеть и за пару месяцев съедают диск.
    docker image prune -f >/dev/null
    "${COMPOSE[@]}" ps
    exit 0
  fi
  sleep 3
done

echo "Приложение не поднялось за 3 минуты — последние строки логов:" >&2
"${COMPOSE[@]}" logs --tail 40 app >&2
exit 1
