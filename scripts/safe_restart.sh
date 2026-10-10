#!/bin/bash
# Перезапуск бэкенда, когда никого не обрывает: ждём завершения заданий.
deadline=$(( $(date +%s) + ${1:-600} ))
while :; do
  busy=$(cd /tmp && sudo -u postgres psql -d tiltap -tAc "select count(*) from transcription_requests where status not in ('completed','error') and created_at > now()-interval '15 minutes'")
  lab=$(grep -l '"status": "transcribing"\|"status": "translating"' /opt/tiltap-lab/jobs/*/job.json 2>/dev/null | wc -l)
  if [ "${busy:-0}" -eq 0 ] && [ "$lab" -eq 0 ]; then
    systemctl restart tiltab-backend && sleep 6
    echo "перезапущен, активных заданий не было"
    systemctl is-active tiltab-backend tiltab-telegram-poll
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "не дождался: заданий в работе $busy (бот) и $lab (лаборатория)"
    exit 1
  fi
  echo "жду: в работе $busy заданий..."
  sleep 15
done
