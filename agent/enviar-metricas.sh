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
#   ENVIOS_POR_MINUTO=3    (opcional: 3 = cada 20 s, para que los avisos lleguen antes; 1 = como antes)
#
# Prueba sin enviar nada:   DRY_RUN=1 ./enviar-metricas.sh
# Cron, cada minuto (en /etc/crontab):
#   * * * * * root /root/monitor.sh > /dev/null 2>&1

# Si el cron lo lanza con «sh script» (dash), se vuelve a lanzar con bash: lo necesita.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

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
ENVIOS_POR_MINUTO="${ENVIOS_POR_MINUTO:-3}"
case "$ENVIOS_POR_MINUTO" in '' | *[!0-9]* | 0) ENVIOS_POR_MINUTO=1 ;; esac
[ "$ENVIOS_POR_MINUTO" -gt 6 ] && ENVIOS_POR_MINUTO=6

if [ -z "$SERVER_ID" ]; then
  echo "Error: falta SERVER_ID (defínelo en $ENV_FILE)" >&2
  # El cron descarta la salida: que quede también en el registro del sistema (journalctl -t server-panel).
  command -v logger > /dev/null 2>&1 && logger -t server-panel "Falta SERVER_ID en $ENV_FILE: no se envían métricas al panel"
  exit 1
fi

# Texto seguro para meter dentro de una cadena JSON.
json_str() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Nombres con los que se llega a cada contenedor dentro de Docker (el servicio del stack y los alias
# de red) y sus IPs internas. Así el panel sabe qué contenedor hay detrás de cada web de Nginx Proxy
# Manager aunque NPM apunte a «app:3000» o a «172.18.0.5:3000» en vez de al nombre del contenedor.
declare -A RED_ALIAS RED_IPS RED_PORTS
leer_red_docker() {
  local ids cname svc nets binds part w alias ips ports i
  local -a parts
  ids=$(docker ps -aq 2> /dev/null) || return 0
  [ -z "$ids" ] && return 0
  # Por cada red: «IP;alias alias ;». Un contenedor parado no tiene IP (Docker 29 escribe «invalid IP»).
  while IFS='|' read -r cname svc nets binds; do
    cname=${cname#/}
    [ -z "$cname" ] && continue
    alias="" ips="" ports=""
    case "$svc" in '' | '<no value>') ;; *) alias="$svc" ;; esac
    IFS=';' read -ra parts <<< "$nets"
    i=0
    for part in "${parts[@]}"; do
      if [ $((i % 2)) -eq 0 ]; then
        [[ $part =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && ips="${ips:+$ips }$part"
      else
        for w in $part; do
          # El id corto y el propio nombre no aportan nada
          [[ $w =~ ^[0-9a-f]{12}$ ]] || [ "$w" = "$cname" ] || [ "$w" = '<no value>' ] && continue
          case " $alias " in *" $w "*) ;; *) alias="${alias:+$alias }$w" ;; esac
        done
      fi
      i=$((i + 1))
    done
    # Puertos publicados según su configuración: `docker ps` no los enseña si el contenedor está parado.
    for w in $binds; do
      case "$w" in [0-9]*'->'*) ports="${ports:+$ports, }0.0.0.0:$w" ;; esac
    done
    RED_ALIAS[$cname]=$alias
    RED_IPS[$cname]=$ips
    RED_PORTS[$cname]=$ports
  done < <(docker inspect -f '{{.Name}}|{{index .Config.Labels "com.docker.compose.service"}}|{{range $n, $c := .NetworkSettings.Networks}}{{$c.IPAddress}};{{range $c.Aliases}}{{.}} {{end}};{{end}}|{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}->{{$p}} {{end}}{{end}}' $ids 2> /dev/null)
}

# Apache instalado en la máquina como proxy inverso (sin Docker): sus webs y a dónde manda cada una,
# leído de sus sitios activos. Así el panel lo trata como un proxy más, igual que Nginx Proxy Manager.
leer_apache() {
  APACHE_FOUND=""
  APACHE_JSON=""
  local dir
  for dir in /etc/apache2/sites-enabled /etc/httpd/conf.d /etc/httpd/sites-enabled; do
    [ -d "$dir" ] || continue
    APACHE_FOUND=1
    APACHE_JSON=$(for f in "$dir"/*.conf; do [ -f "$f" ] && { echo "### $f"; cat "$f"; }; done 2> /dev/null | awk '
      function flush(   n, i, d, arr, url, rest, scheme, host, port, c) {
        if (names == "") return
        n = split(names, arr, " "); d = ""
        for (i = 1; i <= n; i++) if (arr[i] ~ /^[A-Za-z0-9*.-]+$/ && arr[i] ~ /\./) d = d (d == "" ? "" : ",") "\"" tolower(arr[i]) "\""
        if (d == "") return
        scheme = "http"; host = ""; port = 0; url = target
        if (url ~ /^https?:\/\//) {
          c = index(url, "://"); scheme = substr(url, 1, c - 1); rest = substr(url, c + 3); sub(/\/.*$/, "", rest)
          host = rest; port = (scheme == "https" ? 443 : 80)
          if (index(rest, ":")) { host = substr(rest, 1, index(rest, ":") - 1); port = substr(rest, index(rest, ":") + 1) }
        }
        all = all (all == "" ? "" : ",") "{\"domains\":[" d "],\"host\":\"" tolower(host) "\",\"port\":" (port ~ /^[0-9]+$/ ? port : 0) \
          ",\"scheme\":\"" scheme "\",\"ssl\":" (ssl ? "true" : "false") ",\"error\":false}"
      }
      /^[ \t]*#/ { next }
      { k = tolower($1) }
      k ~ /^<virtualhost/ { names = ""; target = ""; ssl = ($0 ~ /:443/); next }
      k == "</virtualhost>" { flush(); names = ""; next }
      k == "servername" { names = names " " $2; next }
      k == "serveralias" { for (i = 2; i <= NF; i++) names = names " " $i; next }
      k == "sslengine" && tolower($2) == "on" { ssl = 1; next }
      k == "proxypass" { p = $2; t = $3; gsub(/"/, "", p); gsub(/"/, "", t); if (p == "/" && target == "" && t ~ /^https?:\/\//) target = t; next }
      k == "rewriterule" && (index($0, "[P") || index($0, ",P]") || index($0, ",P,")) { t = $3; gsub(/"/, "", t); if (target == "" && t ~ /^https?:\/\//) target = t; next }
      END { print all }')
    break
  done
}

# Nginx Proxy Manager de este servidor (si lo hay): qué dominio manda a qué contenedor y puerto.
# Se lee de sus archivos de configuración (/data/nginx/proxy_host/*.conf), sin usuario ni contraseña.
# Un archivo .conf.err es un host que NPM no ha podido cargar (error de configuración).
leer_npm() {
  NPM_FOUND=""
  NPM_JSON=""
  NPM_SRC=""
  command -v docker > /dev/null 2>&1 || return 0
  local id="" src="" stream line cid csrc
  # NPM se reconoce por lo que es (un contenedor con /data/nginx/proxy_host), no por el nombre de su imagen:
  # vale para jc21/nginx-proxy-manager, NPMplus, imágenes propias…
  while IFS='|' read -r cid csrc; do
    if [ -n "$csrc" ] && [ -d "$csrc/nginx/proxy_host" ]; then
      id="$cid"
      src="$csrc"
      break
    fi
  done < <(docker inspect -f '{{.Id}}|{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' $(docker ps -aq 2> /dev/null) 2> /dev/null)
  # Si la carpeta no se ve desde fuera, se busca por el nombre de la imagen y se lee desde dentro del contenedor.
  if [ -z "$id" ]; then
    id=$(docker ps -a --format '{{.ID}}|{{.Image}}|{{.Names}}' 2> /dev/null |
      awk -F'|' 'tolower($2 " " $3) ~ /nginx-proxy-manager|npmplus|nginxproxymanager/ { print $1; exit }')
  fi
  [ -n "$id" ] || return 0
  if [ -n "$src" ] && [ -d "$src/nginx/proxy_host" ]; then
    NPM_SRC="$src"
    stream=$(for f in "$src"/nginx/proxy_host/*.conf "$src"/nginx/proxy_host/*.conf.err; do
      [ -f "$f" ] && { echo "### $f"; cat "$f"; }
    done)
  else
    # Sin acceso a la carpeta desde fuera: se pide al propio contenedor (solo si está en marcha).
    stream=$(docker exec "$id" sh -c 'for f in /data/nginx/proxy_host/*.conf /data/nginx/proxy_host/*.conf.err; do [ -f "$f" ] && { echo "### $f"; cat "$f"; }; done' 2>/dev/null) || return 0
  fi
  NPM_FOUND=1
  NPM_JSON=$(printf '%s\n' "$stream" | awk '
    function out(   n, i, d, arr) {
      if (names == "") return
      n = split(names, arr, /[ \t]+/); d = ""
      for (i = 1; i <= n; i++) if (arr[i] != "") d = d (d == "" ? "" : ",") "\"" arr[i] "\""
      root = (rootx != "" ? rootx : rootr); fallback = (fbname != "" && (fbname in fb) ? fb[fbname] : "")
      all = all (all == "" ? "" : ",") "{\"domains\":[" d "],\"host\":\"" host "\",\"port\":" (port ~ /^[0-9]+$/ ? port : 0) \
        ",\"scheme\":\"" scheme "\",\"ssl\":" (ssl ? "true" : "false") ",\"error\":" (err ? "true" : "false") \
        ",\"root\":\"" root "\",\"fallback\":\"" fallback "\"}"
    }
    /^### / { out(); names = ""; host = ""; port = ""; scheme = "http"; ssl = 0; err = ($2 ~ /\.err$/); loc = ""; rootx = ""; rootr = ""; fbname = ""; split("", fb); next }
    /^[ \t]*#/ { next }
    # Configuración avanzada: a dónde va de verdad la portada y el respaldo si el destino falla.
    /^[ \t]*location[ \t]/ {
      v = $0; loc = "o"
      if (v ~ /location[ \t]+=[ \t]*\/[ \t]*\{/) loc = "x"
      else if (v ~ /location[ \t]+\/[ \t]*\{/) loc = "r"
      else if (match(v, /@[A-Za-z0-9_-]+/)) loc = substr(v, RSTART, RLENGTH)
      next
    }
    /^[ \t]*proxy_pass[ \t]/ {
      v = $2; sub(/;.*$/, "", v)
      if (v !~ /\$/ && v ~ /^https?:\/\//) { if (loc == "x") rootx = v; else if (loc == "r" && rootr == "") rootr = v; else if (loc ~ /^@/) fb[loc] = v }
      next
    }
    /^[ \t]*error_page[ \t]/ { if (match($0, /@[A-Za-z0-9_-]+/)) fbname = substr($0, RSTART, RLENGTH); next }
    /^[ \t]*server_name[ \t]/ { if (names == "") { v = $0; sub(/^[ \t]*server_name[ \t]+/, "", v); sub(/;.*$/, "", v); gsub(/["\\]/, "", v); names = v }; next }
    /^[ \t]*set[ \t]+\$server[ \t]/ { if (host == "") { v = $0; sub(/^[ \t]*set[ \t]+\$server[ \t]+/, "", v); sub(/;.*$/, "", v); gsub(/["\\ \t]/, "", v); host = v }; next }
    /^[ \t]*set[ \t]+\$port[ \t]/ { if (port == "") { v = $3; sub(/;.*$/, "", v); gsub(/"/, "", v); port = v }; next }
    /^[ \t]*set[ \t]+\$forward_scheme[ \t]/ { v = $3; sub(/;.*$/, "", v); gsub(/["\\]/, "", v); scheme = v; next }
    /^[ \t]*listen[ \t].*443/ { ssl = 1 }
    END { out(); print all }
  ')
}

# Tráfico real de las webs: los access logs de NPM (/data/logs/proxy-host-N_access.log).
# Se leen solo las líneas nuevas desde el último envío (se guarda hasta dónde se leyó) y se mandan
# las visitas por dominio y minuto, con cuántas fallaron (5xx) y cuántas eran de pasarela (502/503/504).
leer_trafico_npm() {
  NPM_TRAFFIC=""
  [ -n "$NPM_SRC" ] && [ -d "$NPM_SRC/logs" ] || return 0
  local dir="${STATE_DIR:-/var/lib/server-panel}" state new tmp f size inode prev off
  mkdir -p "$dir" 2> /dev/null || return 0
  state="$dir/npm-logs.state"
  new="$state.$$"
  tmp=$(mktemp) || return 0
  touch "$state" 2> /dev/null || return 0
  : > "$new"
  for f in "$NPM_SRC"/logs/proxy-host-*_access.log; do
    [ -f "$f" ] || continue
    size=$(stat -c %s "$f" 2> /dev/null) || continue
    inode=$(stat -c %i "$f" 2> /dev/null)
    prev=$(awk -v f="$f" '$1 == f { print $2 " " $3; exit }' "$state")
    off=${prev#* }
    if [ -z "$prev" ]; then
      # Primera vez: se empieza por el último mega para no mandar todo el histórico.
      off=$((size > 1048576 ? size - 1048576 : 0))
    elif [ "${prev%% *}" != "$inode" ] || [ "$off" -gt "$size" ]; then
      off=0 # el log se ha rotado
    fi
    [ "$size" -gt "$off" ] && tail -c +$((off + 1)) "$f" 2> /dev/null | head -c 4194304 >> "$tmp"
    echo "$f $inode $size" >> "$new"
  done
  # Formato de NPM: [25/Nov/2026:10:15:32 +0000] - 502 502 - GET https dominio "/ruta" [Client …] …
  NPM_TRAFFIC=$(awk '
    # Las comprobaciones automáticas (este panel, Uptime Kuma…) no son visitas reales.
    /ServerPanel-Monitor|Uptime-Kuma|UptimeRobot|StatusCake|Pingdom/ { next }
    substr($0, 1, 1) == "[" {
      rb = index($0, "]"); t = substr($0, 2, rb - 2)
      rest = substr($0, rb + 2); p = index(rest, " - "); if (!p) next
      nb = split(substr(rest, 1, p - 1), b, " "); status = b[nb]
      split(substr(rest, p + 3), a, " "); host = tolower(a[3])
      if (host !~ /^[a-z0-9.-]+$/ || length(t) < 26) next
      k = host "|" substr(t, 1, 17) " " substr(t, 22, 5)
      n[k]++
      if (status ~ /^5/) e5[k]++
      if (status == "502" || status == "503" || status == "504") gw[k]++
    }
    END {
      out = ""
      for (k in n) {
        split(k, kk, "|")
        out = out (out == "" ? "" : ",") "{\"host\":\"" kk[1] "\",\"m\":\"" kk[2] "\",\"n\":" n[k] ",\"e5\":" (e5[k] + 0) ",\"gw\":" (gw[k] + 0) "}"
      }
      print out
    }' "$tmp")
  rm -f "$tmp"
  # En pruebas (DRY_RUN) no se avanza: así se puede repetir.
  if [ -n "${DRY_RUN:-}" ]; then rm -f "$new"; else mv "$new" "$state"; fi
}

enviar() {
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
  add_item() { # nombre estado texto_estado imagen puertos
    local extra="" alias="${RED_ALIAS[$1]:-}" ips="${RED_IPS[$1]:-}"
    [ -n "$alias" ] && extra="${extra},\"aliases\":\"$(json_str "$alias")\""
    [ -n "$ips" ] && extra="${extra},\"ips\":\"$(json_str "$ips")\""
    CONTAINERS="${CONTAINERS:+$CONTAINERS,}{\"name\":\"$(json_str "$1")\",\"state\":\"$(json_str "$2")\",\"status\":\"$(json_str "$3")\",\"image\":\"$(json_str "$4")\",\"ports\":\"$(json_str "${5:-}")\"${extra}}"
    TOTAL=$((TOTAL + 1))
    case "$2:$3" in
      running:*) RUNNING=$((RUNNING + 1)) ;;
      :Up*) case "$3" in *"(Paused)"*) ;; *) RUNNING=$((RUNNING + 1)) ;; esac ;;
    esac
  }

  RED_ALIAS=()
  RED_IPS=()
  RED_PORTS=()
  if command -v docker > /dev/null 2>&1; then
    leer_red_docker
    # Sin {{.State}}, que no existe en Docker antiguos: el panel deduce el estado de "Up 3 hours", "Exited (1)…".
    # Los puertos sirven al panel para saber qué contenedor hay detrás de cada web de Nginx Proxy Manager.
    if LIST=$(docker ps -a --format '{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}' 2>/dev/null); then
      while IFS='|' read -r name status image ports; do
        [ -z "$ports" ] && ports="${RED_PORTS[$name]:-}"
        [ -n "$name" ] && add_item "$name" "" "$status" "$image" "$ports"
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
  # IPs de este servidor (para reconocer las direcciones de destino de Nginx Proxy Manager)
  IPS=""
  for ip in $(hostname -I 2>/dev/null); do
    IPS="${IPS:+$IPS,}\"$(json_str "$ip")\""
  done

  leer_npm
  leer_trafico_npm
  NPM_PART=""
  [ -n "$NPM_FOUND" ] && NPM_PART=",\"npm\":[${NPM_JSON}]"
  [ -n "$NPM_TRAFFIC" ] && NPM_PART="${NPM_PART},\"npmTraffic\":[${NPM_TRAFFIC}]"
  leer_apache
  [ -n "$APACHE_FOUND" ] && NPM_PART="${NPM_PART},\"apache\":[${APACHE_JSON}]"

  PAYLOAD="{\"cpu\":${CPU},\"ram\":${RAM},\"disk\":${DISK},\"uptime\":${UPTIME},\"hostname\":\"$(json_str "$HOST")\",\"ips\":[${IPS}],\"containers\":[${CONTAINERS}]${NPM_PART}}"

  if [ -n "${DRY_RUN:-}" ]; then
    echo "$PAYLOAD"
    echo "(prueba: no se ha enviado nada a ${PANEL_URL})" >&2
    return 0
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
    return 1
  fi

  HTTP_CODE="${RESPONSE##*$'\n'}"
  BODY="${RESPONSE%$'\n'*}"
  if [ "$HTTP_CODE" != "200" ]; then
    echo "Error: el panel respondió $HTTP_CODE: $BODY" >&2
    return 1
  fi

  echo "OK ${SERVER_ID}: CPU ${CPU}% · RAM ${RAM}% · disco ${DISK}% · contenedores ${RUNNING}/${TOTAL}"
}

# Cron lo lanza una vez por minuto: dentro del minuto se envía ENVIOS_POR_MINUTO veces, repartidas.
if [ -n "${DRY_RUN:-}" ]; then
  enviar
  exit $?
fi
# Si la ejecución anterior aún no ha terminado (red lenta), esta no hace nada.
if command -v flock > /dev/null 2>&1; then
  exec 9> "/tmp/server-panel-${SERVER_ID//[^A-Za-z0-9_.-]/_}.lock"
  flock -n 9 || exit 0
fi
PASO=$((60 / ENVIOS_POR_MINUTO))
INICIO=$(date +%s)
RESULTADO=0
for ((i = 0; i < ENVIOS_POR_MINUTO; i++)); do
  if [ "$i" -gt 0 ]; then
    ESPERA=$((INICIO + i * PASO - $(date +%s)))
    [ "$ESPERA" -gt 0 ] && sleep "$ESPERA"
  fi
  enviar || RESULTADO=1
done
exit "$RESULTADO"
