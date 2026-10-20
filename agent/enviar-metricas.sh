#!/usr/bin/env bash
# Envía las métricas de este servidor al Server Panel.
#
# Requisitos: bash y curl. Docker y Proxmox (pct/qm) son opcionales: se informa de lo que haya.
# Debe ejecutarlo root (o un usuario del grupo docker) para poder leer contenedores y máquinas.
#
# Configuración en /etc/server-panel.env (permisos 600) o como variables de entorno:
#   SERVER_ID=rpi-1
#   PANEL_URL=https://panel.marcogugliandolo.com
#   STATS_TOKEN=el-mismo-valor-que-en-el-panel
#   DISK_PATH=/            (opcional: disco a medir)
#
# Prueba sin enviar nada:   DRY_RUN=1 ./enviar-metricas.sh
# Cron, cada minuto (en /etc/crontab):
#   * * * * * root /root/monitor.sh > /dev/null 2>&1

export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export LC_ALL=C
set -o pipefail

ENV_FILE="${PANEL_ENV_FILE:-/etc/server-panel.env}"
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

SERVER_ID="${SERVER_ID:-}"
PANEL_URL="${PANEL_URL:-https://panel.marcogugliandolo.com}"
STATS_TOKEN="${STATS_TOKEN:-}"
DISK_PATH="${DISK_PATH:-/}"

if [ -z "$SERVER_ID" ]; then
  echo "Error: falta SERVER_ID (defínelo en $ENV_FILE)" >&2
  exit 1
fi

# Texto seguro para meter dentro de una cadena JSON.
json_str() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

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

# 3. Disco, tiempo encendido y nombre
DISK=$(df -P "$DISK_PATH" 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }')
case "$DISK" in '' | *[!0-9]*) DISK=null ;; esac
UPTIME=$(cut -d. -f1 /proc/uptime)
case "$UPTIME" in '' | *[!0-9]*) UPTIME=null ;; esac
HOST=$(hostname)

# 4. Contenedores y máquinas: todos, también los parados, con su estado
CONTAINERS=""
RUNNING=0
TOTAL=0
add_item() { # nombre estado texto_estado imagen
  CONTAINERS="${CONTAINERS:+$CONTAINERS,}{\"name\":\"$(json_str "$1")\",\"state\":\"$(json_str "$2")\",\"status\":\"$(json_str "$3")\",\"image\":\"$(json_str "$4")\"}"
  TOTAL=$((TOTAL + 1))
  case "$2:$3" in
    running:*) RUNNING=$((RUNNING + 1)) ;;
    :Up*) case "$3" in *"(Paused)"*) ;; *) RUNNING=$((RUNNING + 1)) ;; esac ;;
  esac
}

if command -v docker > /dev/null 2>&1; then
  # Sin {{.State}}, que no existe en Docker antiguos: el panel deduce el estado de "Up 3 hours", "Exited (1)…".
  if LIST=$(docker ps -a --format '{{.Names}}|{{.Status}}|{{.Image}}' 2>/dev/null); then
    while IFS='|' read -r name status image; do
      [ -n "$name" ] && add_item "$name" "" "$status" "$image"
    done <<< "$LIST"
  else
    echo "Aviso: no se pudo consultar Docker (¿falta permiso? ejecútalo como root)" >&2
  fi
fi

# Proxmox: contenedores LXC (pct) y máquinas virtuales (qm)
if command -v pct > /dev/null 2>&1; then
  while read -r vmid status rest; do
    [ -z "$vmid" ] && continue
    name=$(printf '%s' "$rest" | awk '{ print $NF }')
    add_item "${name:-ct$vmid}" "$status" "ID $vmid" "Contenedor LXC"
  done < <(pct list 2>/dev/null | awk 'NR > 1')
fi
if command -v qm > /dev/null 2>&1; then
  while read -r vmid name status _rest; do
    [ -z "$vmid" ] && continue
    add_item "${name:-vm$vmid}" "$status" "ID $vmid" "Máquina virtual"
  done < <(qm list 2>/dev/null | awk 'NR > 1')
fi

# 5. Enviar
PAYLOAD="{\"cpu\":${CPU},\"ram\":${RAM},\"disk\":${DISK},\"uptime\":${UPTIME},\"hostname\":\"$(json_str "$HOST")\",\"containers\":[${CONTAINERS}]}"

if [ -n "${DRY_RUN:-}" ]; then
  echo "$PAYLOAD"
  echo "(prueba: no se ha enviado nada a ${PANEL_URL})" >&2
  exit 0
fi

AUTH_HEADER=()
if [ -n "$STATS_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $STATS_TOKEN")
fi

if ! RESPONSE=$(curl -sS -L --post301 --post302 --post303 --max-time 20 -X POST \
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

echo "OK ${SERVER_ID}: CPU ${CPU}% · RAM ${RAM}% · disco ${DISK}% · contenedores ${RUNNING}/${TOTAL}"
