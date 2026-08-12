#!/bin/bash
#
# Ежедневная резервная копия корпуса разметки и базы.
#
# Корпус — единственные данные в проекте, которые нельзя пересоздать: запрос к
# боту можно повторить, а час вычитки лингвиста повторить нельзя.
#
# Хранится одна копия, она переписывается каждую ночь. Отсюда два правила,
# без которых одна копия опаснее, чем ноль копий:
#
#   1. Новая копия готовится рядом и встаёт на место только после проверки.
#      Прерванный на середине бэкап иначе затирает единственный целый.
#   2. Пустой источник — это отказ, а не команда стереть копию. Если каталог
#      с данными исчез или не примонтирован, rsync --delete аккуратно повторил
#      бы эту пустоту в бэкапе и уничтожил последнее, что оставалось.
#
# Ставится в cron:
#   30 3 * * * /opt/tiltap/scripts/backup.sh >> /var/log/tiltap-backup.log 2>&1

set -euo pipefail

# Переопределяемы, чтобы защиты можно было проверить на отдельном каталоге,
# а не на единственной боевой копии.
DATA_DIR="${DATA_DIR:-/opt/tiltap/data/dataset}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/backups}"
DB_NAME="${DB_NAME:-tiltap}"

DB_FILE="$BACKUP_ROOT/tiltap.dump"
DB_TMP="$BACKUP_ROOT/tiltap.dump.new"
AUDIO="$BACKUP_ROOT/audio"
AUDIO_TMP="$BACKUP_ROOT/audio.new"
AUDIO_OLD="$BACKUP_ROOT/audio.old"

log() { echo "[$(date -Is)] $*"; }

# Отказ должен быть слышен. Бэкап, который тихо перестал делаться, — это ровно
# то, как "у нас есть копии" превращается в "мы думали, что есть".
# Токен читается из .env самим скриптом и нигде не печатается.
notify_failure() {
  local message="$1"
  set +u
  if [ -f /opt/tiltap/.env ]; then
    set -a
    . /opt/tiltap/.env 2>/dev/null || true
    set +a
  fi
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TILTAB_ADMIN_CHAT_ID" ]; then
    curl -s -m 20 -o /dev/null \
      "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$TILTAB_ADMIN_CHAT_ID" \
      --data-urlencode "text=Бэкап корпуса не сделан: $message" || true
  fi
  set -u
}

fail() {
  # Снимаем ловушку, иначе о своей же обработанной ошибке придёт два сообщения.
  trap - EXIT
  log "ОТКАЗ: $1"
  notify_failure "$1"
  exit 1
}

# Ловит и то, чего мы не предусмотрели: нехватку места, убитый процесс.
trap 'code=$?; [ $code -ne 0 ] && log "прерван с кодом $code" && notify_failure "прерван с кодом $code"' EXIT

# sudo -u postgres из /root печатает предупреждение о недоступном каталоге при
# каждом запуске. Уходим туда, куда postgres попасть может.
cd /tmp

mkdir -p "$BACKUP_ROOT"
# Внутри лежат все расшифровки и вся база: читать это посторонним незачем.
chmod 700 "$BACKUP_ROOT"
log "backup start"

# --- Проверка источника ----------------------------------------------------
if [ ! -d "$DATA_DIR" ]; then
  fail "каталога $DATA_DIR нет, копию не трогаю"
fi

SRC_FILES=$(find "$DATA_DIR" -type f | wc -l)
OLD_FILES=0
[ -d "$AUDIO" ] && OLD_FILES=$(find "$AUDIO" -type f | wc -l)

# Корпус только растёт: клипы после нарезки не меняются, а удаление записи —
# редкое ручное действие. Резкая усадка почти наверняка означает поломку, а не
# намерение, и повторять её в бэкапе нельзя.
if [ "$OLD_FILES" -gt 20 ] && [ "$SRC_FILES" -lt $((OLD_FILES / 2)) ]; then
  fail "файлов в данных $SRC_FILES, в копии $OLD_FILES — источник усох вдвое, копию не трогаю"
fi

# --- База ------------------------------------------------------------------
# Формат custom (-Fc): сжат и позволяет достать одну таблицу, что важнее
# полноты, когда чинишь последствия одной неудачной команды.
# Вывод перенаправляется, а не пишется через -f: файл тогда создаёт root, а не
# postgres, которому в /opt/backups писать нечем и незачем.
sudo -u postgres pg_dump -Fc "$DB_NAME" > "$DB_TMP"

# Дамп, который не читается, бесполезен, а узнать об этом в день аварии —
# поздно. Проверяем оглавление до того, как заменить прошлый. Для --list база
# не нужна, это чтение файла, поэтому и прав postgres не требуется.
if ! pg_restore --list "$DB_TMP" > /dev/null 2>&1; then
  rm -f "$DB_TMP"
  fail "новый дамп базы не читается, прежний оставлен на месте"
fi

mv -f "$DB_TMP" "$DB_FILE"
log "база: $(du -h "$DB_FILE" | cut -f1)"

# --- Аудио -----------------------------------------------------------------
# --link-dest на текущую копию: неизменившиеся файлы не копируются, а
# связываются жёсткой ссылкой. Поэтому подготовка копии рядом со старой не
# требует второго объёма на диске и занимает секунды.
rm -rf "$AUDIO_TMP"
if [ -d "$AUDIO" ]; then
  rsync -a --delete --link-dest="$AUDIO" "$DATA_DIR/" "$AUDIO_TMP/"
else
  rsync -a "$DATA_DIR/" "$AUDIO_TMP/"
fi

NEW_FILES=$(find "$AUDIO_TMP" -type f | wc -l)
if [ "$NEW_FILES" -ne "$SRC_FILES" ]; then
  rm -rf "$AUDIO_TMP"
  fail "скопировано $NEW_FILES файлов из $SRC_FILES, прежняя копия оставлена"
fi

# Подмена в два шага: в любой момент на диске есть хотя бы одна целая копия.
if [ -d "$AUDIO" ]; then
  rm -rf "$AUDIO_OLD"
  mv "$AUDIO" "$AUDIO_OLD"
fi
mv "$AUDIO_TMP" "$AUDIO"
rm -rf "$AUDIO_OLD"

log "аудио: $SRC_FILES файлов, $(du -sh "$AUDIO" | cut -f1)"
log "backup ok, всего занято: $(du -sh "$BACKUP_ROOT" | cut -f1)"

trap - EXIT
