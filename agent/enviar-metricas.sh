#!/usr/bin/env bash
# Envía las métricas de este servidor al Server Panel.
#
# Requisitos: bash, curl y jq. Docker es opcional (sin él se envía la lista vacía).
# Debe ejecutarlo root o un usuario del grupo docker para poder leer los contenedores.
#
# Configuración: en /etc/server-panel.env (recomendado, con permisos 600) o como variables de entorno:
#   SERVER_ID=rpi-1
#   PANEL_URL=https://panel.marcogugliandolo.com
#   STATS_TOKEN=el-mismo-valor-que-en-el-panel
#   DISK_PATH=/            (opcional: disco a medir)
#
# Cron, cada minuto (en /etc/crontab):
#   * * * * * root /root/monitor.sh > /dev/null 2>&1

set -o pipefail

ENV_FILE="${PANEL_ENV_FILE:-/etc/server-panel.env}"
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

SERVER_ID="${SERVER_ID:-rpi-1}"
PANEL_URL="${PANEL_URL:-https://panel.marcogugliandolo.com}"
STATS_TOKEN="${STATS_TOKEN:-}"
DISK_PATH="${DISK_PATH:-/}"

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: falta '$cmd'. Instálalo con: sudo apt install $cmd" >&2
    exit 1
  fi
done

# 1. CPU: uso medio durante 1 segundo, a partir de /proc/stat
read_cpu() {
  local _label user nice system idle iowait irq softirq steal _rest
  read -r _label user nice system idle iowait irq softirq steal _rest < /proc/stat
  echo "$((user + nice + system + idle + iowait + irq + softirq + steal)) $((idle + iowait))"
}
read -r TOTAL_1 IDLE_1 <<< "$(read_cpu)"
sleep 1
read -r TOTAL_2 IDLE_2 <<< "$(read_cpu)"
CPU=$(awk -v t="$((TOTAL_2 - TOTAL_1))" -v i="$((IDLE_2 - IDLE_1))" \
  'BEGIN { if (t > 0) printf "%.1f", 100 * (1 - i / t); else print 0 }')

# 2. RAM: memoria realmente ocupada (total menos disponible)
RAM=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 }
  END { if (t > 0) printf "%.1f", 100 * (t - a) / t; else print 0 }' /proc/meminfo)

# 3. Disco y tiempo encendido
DISK=$(df -P "$DISK_PATH" 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }')
UPTIME=$(cut -d. -f1 /proc/uptime)
HOST=$(hostname)

# 4. Contenedores: todos (también los parados), con su estado
CONTAINERS='[]'
if command -v docker >/dev/null 2>&1; then
  if LIST=$(docker ps -a --format '{{json .}}' 2>/dev/null); then
    # .State no existe en Docker antiguos: el panel lo deduce entonces de .Status ("Up 3 hours", "Exited (1)…").
    CONTAINERS=$(printf '%s\n' "$LIST" | jq -s -c \
      'map(select(type == "object") | {name: .Names, state: (.State // ""), status: .Status, image: .Image})') \
      || CONTAINERS='[]'
  else
    echo "Aviso: no se pudo consultar Docker (¿falta permiso? ejecútalo como root o en el grupo docker)" >&2
  fi
fi

# 5. Enviar
PAYLOAD=$(jq -n -c \
  --arg cpu "$CPU" --arg ram "$RAM" --arg disk "$DISK" --arg uptime "$UPTIME" --arg hostname "$HOST" \
  --argjson containers "$CONTAINERS" \
  '{
    cpu: ($cpu | tonumber? // null),
    ram: ($ram | tonumber? // null),
    disk: ($disk | tonumber? // null),
    uptime: ($uptime | tonumber? // null),
    hostname: $hostname,
    containers: $containers
  }')

AUTH_HEADER=()
if [ -n "$STATS_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $STATS_TOKEN")
fi

if ! RESPONSE=$(curl -sS --max-time 20 -X POST \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]}" \
  --data "$PAYLOAD" \
  -w '\n%{http_code}' \
  "${PANEL_URL%/}/api/stats/$SERVER_ID"); then
  echo "Error: no se pudo contactar con ${PANEL_URL}" >&2
  exit 1
fi

HTTP_CODE="${RESPONSE##*$'\n'}"
BODY="${RESPONSE%$'\n'*}"
if [ "$HTTP_CODE" != "200" ]; then
  echo "Error: el panel respondió $HTTP_CODE: $BODY" >&2
  exit 1
fi

RUNNING=$(printf '%s' "$CONTAINERS" | jq '[.[] | select(.state == "running"
  or (.state == "" and (.status // "" | startswith("Up")) and ((.status // "") | test("\\(Paused\\)") | not)))] | length')
TOTAL=$(printf '%s' "$CONTAINERS" | jq 'length')
echo "OK ${SERVER_ID}: CPU ${CPU}% · RAM ${RAM}% · disco ${DISK:-?}% · contenedores ${RUNNING}/${TOTAL}"
