# Server Panel

Panel de control de la infraestructura propia: Raspberry Pi, VPS de Contabo y Oracle, Proxmox… Muestra el estado de cada servidor en un esquema de red, guarda su historial, controla sus contenedores a través de Portainer y vigila que las webs respondan.

## Qué hace

- **Tres secciones en la cabecera: Clásica, Oficina y Webs.**
  - **Clásica.** El esquema de red de siempre: tarjetas con IP, CPU, RAM y contenedores, y conexiones que se colorean según el estado del servidor al que llegan. Con **Editar Diseño** se añaden, mueven y eliminan nodos, zonas y conexiones.
  - **Oficina** (con un selector **Plano / Edificio**). En el **plano**, cada servidor es un empleado en su mesa (pixel art): teclea más rápido cuanta más CPU usa, apila papeles según la RAM, su pantalla de pared muestra CPU/RAM/disco y su corcho tiene una nota por contenedor. Si deja de enviar métricas, su silla se queda vacía. La recepción atiende las webs (un teléfono por web; al pulsar una se abre en la sección Webs) y en el CPD están el router (y el resto del equipo de red del esquema) y un rack con una luz por equipo de casa. El **edificio** es la misma oficina en corte por plantas: los VPS en la planta 2, los equipos de casa y el CPD en la planta 1, la recepción abajo y tu despacho en el ático; pulsar una planta lleva al plano. El cielo y las ventanas siguen la hora real (con la salida y la puesta del sol de Madrid). Al lado, la plantilla y un registro de lo que va pasando. Solo aparecen los servidores del esquema; los ids que envían métricas sin estar en él se listan aparte para poder olvidarlos.
  - **Webs.** Todas las webs con una minibarra de las últimas 24 h. Al elegir una se ve su ficha: la **ruta de una visita animada** (visitante → DNS → servidor → HTTPS → Nginx Proxy Manager → contenedor → aplicación) con el punto exacto donde se corta; la **disponibilidad** en 24 h, 7 o 30 días (en rojo los tramos con corte, en amarillo los fallos sueltos); la **lista de cortes** con cuándo empezaron, cuánto duraron y su causa (la que encontró el diagnóstico durante el corte, que se guarda); y las **visitas reales** leídas de los logs de NPM, con las que fallaron en rojo. Si el fallo es un contenedor parado, se arranca con un botón.
- **Solo las webs de Nginx Proxy Manager** (activado de serie, en Webs, debajo del botón de NPM). El panel vigila únicamente las webs que están en algún NPM: las demás se quitan solas, y las que borres de NPM dejan de vigilarse a los pocos minutos (solo si siguen fuera de NPM durante unos minutos, por si un envío del script llega incompleto). Mientras no lleguen datos de ningún NPM no se quita nada. En la lista sale un aviso con las webs quitadas. Con el ajuste desactivado, se pueden vigilar webs que no estén en NPM y buscarlas en tus certificados.
- **Solo las webs que funcionan** (activado de serie, en el mismo sitio). Se apartan las que no han respondido nunca desde que se vigilan, las que NPM tiene desactivadas o con la configuración rota («Offline») y las que llevan un día entero sin responder. Una web que funcionaba y se cae se queda en la lista y te avisa; solo se aparta si sigue caída un día. Las apartadas se ven en «N webs apartadas», se vuelven a probar cada 10 minutos y vuelven solas a la lista en cuanto responden (o al arreglarlas en NPM). Con «Vigilar igualmente» se fija una para que no se aparte nunca.
- **Encontrar todas tus webs.** En Webs → **Buscar todas tus webs**: cada certificado HTTPS queda apuntado en registros públicos (Certificate Transparency), así que el panel los consulta para tus dominios (los de las webs que ya vigila, los de NPM y los que añadas a mano), comprueba qué nombres siguen existiendo y responden y te propone las que aún no vigilas, separadas en *Responden*, *Existen pero no responden* y *Antiguas*. Marcas las que quieras y pasan a vigilarse; las que descartas no vuelven a proponerse. Se repite sola una vez al día y, si aparecen webs nuevas, sale un aviso en la lista. Usa crt.sh (y Cert Spotter si crt.sh no contesta); no necesita usuario ni acceso a NPM.
- **Para cualquier pantalla.** Móvil, tablet y ordenador: en el móvil la cabecera cabe en una fila, la lista de webs y su ficha son dos pantallas (con «Todas las webs» para volver), la ruta de la visita se dibuja de arriba abajo con la explicación de cada paso al lado, las barras se agrupan para que se puedan tocar y el plano de la oficina se desliza de lado.
- **Encargos.** Al arrancar, parar o reiniciar un contenedor (o comprobar una web), sales del despacho, llevas la carpeta a la mesa (en ascensor en el edificio) y el empleado lo hace; el resultado aparece en su bocadillo y en el registro. La acción es real: va por Portainer.
- **Historial y gráficas.** Un punto por minuto y servidor, con rangos de 1 h a 30 días y vista en tabla.
- **Contenedores vía Portainer.** Estado real de todos los contenedores, arrancar, parar, reiniciar y leer logs.
- **Monitor de webs.** Comprueba cada URL a intervalos, mide el tiempo de respuesta, calcula el uptime y avisa si el certificado SSL va a caducar. La primera vez que arranca sin webs vigila vaixataxi.es, panel.marcogugliandolo.com y portainer.marcogugliandolo.com.
- **Nginx Proxy Manager.** No hay que configurar nada: el script de métricas del servidor donde está NPM detecta su contenedor (por la carpeta `/data` que monta, así que vale cualquier imagen: jc21, NPMplus…) y lee sus proxy hosts de los archivos de configuración (`/data/nginx/proxy_host/*.conf`), sin usuario ni contraseña. El panel empieza a vigilar solo todas esas webs, y las que añadas después en NPM también (se puede desactivar en Recepción → **Nginx Proxy Manager**). Una web que dejas de vigilar no vuelve a añadirse sola. Si algún NPM está en una máquina sin el script, se puede conectar también con su API (dirección del puerto 81 y un usuario, mejor de solo lectura).
- **Dónde se ha caído una web.** Cuando una web cae, el panel sigue la ruta de una visita y marca el primer paso que falla: **DNS** (no existe o apunta a otra IP que el resto de tus webs) → **servidor** (no se llega por red; si además no envía métricas, está apagado) → **certificado** (caducado, de otro dominio o autofirmado) → **Nginx Proxy Manager** (no escucha, host desactivado, error de configuración o dominio sin configurar) → **contenedor** de destino (parado o reiniciándose) → **aplicación** (502/504 con el contenedor en marcha, errores 5xx, palabra clave que falta). Se ve en la Recepción, en la campana y en el aviso de Telegram; si el fallo es un contenedor parado, se puede arrancar con un botón (Portainer). También se puede seguir la ruta de cualquier web a mano.
- **Qué contenedor hay detrás de cada web.** El panel lo deduce como lo haría el propio NPM, sea cual sea el destino que tenga puesto: el nombre del contenedor, el del servicio del stack o un alias de red (`app:3000`); su IP interna en la red de Docker (`172.21.0.5:3000`), que recuerda aunque el contenedor esté parado y Docker se la haya quitado; la IP de la máquina, la de Docker (`172.17.0.1`) o su IP pública aunque no esté en la propia máquina, como en Oracle (`82.70.78.105:3050`), con el contenedor que publica ese puerto, también si está parado; `127.0.0.1:81`, que es el propio NPM; y un dominio que va a otra máquina (`casa.midominio.com:80`): si allí hay otro NPM con el script de métricas, sigue la ruta por él hasta el contenedor. En la ficha se explica cómo lo ha encontrado.
- **Avisos.** Servidor sin respuesta, CPU/RAM/disco altos, contenedores caídos, webs caídas y certificados a punto de caducar. Se pueden ocultar hasta el día siguiente.
- **Avisos por Telegram.** Desde la campana → **Avisos por Telegram**: pegas el token de un bot creado con @BotFather, le escribes al bot y el panel encuentra tu chat solo. A partir de ahí te escribe cuando un servidor deja de enviar datos, un contenedor se cae, una web no responde o un certificado está a punto de caducar, y otra vez cuando se recupera (con cuánto tiempo estuvo caído). Lo vigila el propio servidor cada 10 segundos, así que funciona sin tener el panel abierto. Un contenedor parado avisa en unos 20-40 s (con el script que envía cada 20 s), una web caída en menos de un minuto (si falla, se vuelve a comprobar a los 15 s para confirmar) y un servidor que deja de enviar datos, a los 2 minutos. Avisa de cualquier contenedor que estaba en marcha y se para (también con `docker stop`, aunque salga con código 0, y las LXC/VM de Proxmox que se apagan); las tareas puntuales que terminan solas no avisan. Lo que se cae a la vez llega en un solo mensaje y no repite avisos al reiniciar el panel. Lo que paras con los botones del panel no avisa, salvo que actives «También lo que pares tú desde el panel». Se puede elegir qué avisar (CPU/RAM/disco altos va desactivado por defecto).
- **Acceso con sesión real.** La API entera exige iniciar sesión (cookie `HttpOnly`), con límite de intentos fallidos. Los scripts de métricas usan su propio token.
- **Doble factor (TOTP).** Desde el botón de la llave de la cabecera (**Seguridad**) se activa: escaneas el QR con Google Authenticator, Aegis, 1Password, Bitwarden… y a partir de ahí, para entrar hace falta la contraseña y el código de 6 cifras. Al activarlo se dan 10 códigos de recuperación de un solo uso (se pueden regenerar) y se cierran las demás sesiones abiertas. Un código ya usado no vale dos veces.
  - **Si pierdes el móvil y los códigos de recuperación:** añade `PANEL_2FA_RESET=1` al stack, reinicia, entra solo con la contraseña, vuelve a activarlo y **quita la variable**.

## Despliegue en Portainer (stack desde Git)

1. En Portainer: **Stacks → Add stack → Repository**.
   - Repository URL: `https://github.com/marcogugliandolo/Panel`
   - Reference: `refs/heads/main`
   - Compose path: `docker-compose.yml`
2. En **Environment variables** define al menos `PANEL_PASSWORD` (ver la tabla de abajo).
3. Activa **GitOps updates** (por sondeo, por ejemplo cada 5 minutos) si quieres que cada cambio subido a `main` se despliegue solo. Si no, usa **Pull and redeploy** cuando quieras actualizar.
4. Despliega. El panel queda en el puerto `3000` (o el de `PANEL_PORT`).

Los datos (esquema, historial, sesiones y webs) viven en el volumen `panel-data`, montado en `/app/data`. Si ya tenías el panel desplegado con otro volumen, usa ese mismo volumen en el compose (como `external: true`) o copia su `database.sqlite` al nuevo: las tablas antiguas se migran solas al arrancar y el esquema guardado se conserva.

### Alternativa: contenedor que se actualiza al reiniciar

Así está desplegado ahora en el Servidor-Oracle: cada vez que el contenedor arranca, descarga lo último de `main`, instala, compila y arranca. Reiniciar el contenedor = aplicar los cambios.

```yaml
services:
  panel-app:
    image: node:20-slim
    container_name: panel_app
    working_dir: /app
    ports:
      - "3004:3000"
    volumes:
      - ./panel_data:/app/data
    environment:
      - NODE_ENV=production
      - PORT=3000
      - PANEL_USERNAME=${PANEL_USERNAME}
      - PANEL_PASSWORD=${PANEL_PASSWORD}
      - PORTAINER_URL=${PORTAINER_URL}
      - PORTAINER_TOKEN=${PORTAINER_TOKEN}
      - STATS_TOKEN=${STATS_TOKEN}
    restart: always
    command: >
      /bin/sh -c "
      apt-get update && apt-get install -y git python3 make g++ &&
      if [ ! -d '.git' ]; then git init && git remote add origin https://github.com/marcogugliandolo/Panel.git; fi &&
      git fetch origin main &&
      git reset --hard origin/main &&
      npm install --include=dev &&
      npm run build &&
      npm run start
      "
```

Los valores de `${...}` se rellenan en la sección **Environment variables** del stack en Portainer. Para probar una rama antes de fusionarla, cambia `main` por el nombre de la rama en las dos órdenes `git` y reinicia.

### Variables de entorno

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `PANEL_USERNAME` | `admin` | Usuario del panel. |
| `PANEL_PASSWORD` | — | Contraseña del panel. **Obligatoria** con el compose. Sin ella, el servidor genera una temporal en cada arranque y la escribe en los logs. |
| `PANEL_2FA_RESET` | vacío | Con `1`, desactiva el doble factor al arrancar (por si pierdes el acceso). Quítala en cuanto vuelvas a entrar. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | vacío | Opcional: configura Telegram desde el stack en vez de desde el panel. Si están las dos, mandan sobre lo configurado en el panel. |
| `STATS_TOKEN` | vacío | Token que deben enviar los scripts de métricas. Vacío = se aceptan envíos sin token (solo mientras actualizas los scripts). Genera uno con `openssl rand -hex 32`. |
| `PORTAINER_URL` | vacío | URL de Portainer, p. ej. `https://portainer.marcogugliandolo.com`. |
| `PORTAINER_TOKEN` | vacío | Token de acceso de Portainer (**My account → Access tokens**). |
| `OFFLINE_AFTER_MINUTES` | `2` | Minutos sin recibir métricas para dar un servidor por caído. |
| `HISTORY_DAYS` | `30` | Días de historial que se conservan. |
| `PANEL_PORT` | `3000` | Puerto publicado en el host (solo en el compose). |
| `TRUST_PROXY` | redes privadas | Proxies de confianza para `X-Forwarded-*` (Nginx Proxy Manager, Traefik…). |
| `DISCOVERY_CRTSH_URL` / `DISCOVERY_CERTSPOTTER_URL` | `https://crt.sh` / `https://api.certspotter.com` | Dónde consultar los certificados al buscar tus webs (solo para cambiarlo si usas un espejo). |

Con `PORTAINER_URL` y `PORTAINER_TOKEN` configurados, vincula cada servidor con su entorno de Portainer desde **Editar esquema → editar nodo**, o desde la pestaña **Contenedores** del servidor.

## Script de métricas

`agent/enviar-metricas.sh` (que además envía los puertos de cada contenedor —también de los parados—, sus nombres e IPs en las redes de Docker, las IPs del servidor y, si allí hay Nginx Proxy Manager, sus proxy hosts y las visitas de sus access logs —solo las líneas nuevas, guardando hasta dónde leyó en /var/lib/server-panel—) se ejecuta cada minuto en cada servidor (desde cron) y, dentro de ese minuto, envía 3 veces (cada 20 s, ajustable con `ENVIOS_POR_MINUTO`) CPU, RAM, disco, tiempo encendido y el estado de todos los contenedores Docker, también los parados. En Proxmox informa además de los contenedores LXC y las máquinas virtuales. Solo necesita `bash` y `curl`.

### Instalarlo o actualizarlo en un servidor

Como root, cambiando `rpi-1` por el id de ese servidor (`rpi-1`, `rpi-2`, `vps-oracle`, `vps-contabo`, `proxmox-node`):

```bash
# 1. Localiza el script que ya ejecuta cron (si no hay ninguno, se usa /root/monitor.sh)
F=$(grep -l "api/stats" /root/*.sh /usr/local/bin/* 2>/dev/null | head -1); F=${F:-/root/monitor.sh}; echo "$F"

# 2. Sustitúyelo por la versión nueva
curl -fsSL https://raw.githubusercontent.com/marcogugliandolo/Panel/main/agent/enviar-metricas.sh -o "$F" && chmod 700 "$F"

# 3. Configuración de este servidor (el token queda fuera del script)
printf 'SERVER_ID=%s\nPANEL_URL=%s\nSTATS_TOKEN=%s\n' rpi-1 https://panel.marcogugliandolo.com EL-TOKEN > /etc/server-panel.env
chmod 600 /etc/server-panel.env

# 4. Prueba: primero sin enviar nada, luego de verdad (debe responder "OK rpi-1: …")
DRY_RUN=1 "$F" && "$F"
```

La línea de cron no cambia. En un servidor nuevo, añade a `/etc/crontab`:

```
* * * * * root /root/monitor.sh > /dev/null 2>&1
```

`SERVER_ID` tiene que coincidir con el **Id del servidor** del nodo en el esquema. Si un servidor envía datos con un id que no está en el esquema, aparece en la plantilla de la Oficina, en «Fuera del esquema».

El panel sigue aceptando el formato del script antiguo (solo nombres de contenedores en marcha), así que se pueden actualizar los servidores de uno en uno. El panel ignora el token hasta que se define `STATS_TOKEN`: cuando todos los servidores tengan el script nuevo, añádelo al stack.

### Formato del envío

`POST /api/stats/<SERVER_ID>` con `Authorization: Bearer <STATS_TOKEN>`:

```json
{
  "cpu": 12.5,
  "ram": 41.3,
  "disk": 63,
  "uptime": 1036800,
  "hostname": "raspberrypi",
  "containers": [
    { "name": "pihole", "state": "running", "status": "Up 12 days", "image": "pihole/pihole" }
  ]
}
```

## Desarrollo

```bash
npm install
cp .env.example .env   # y rellena PANEL_PASSWORD
npm run dev            # servidor + Vite en http://localhost:3000
npm run lint           # comprobación de tipos
npm run build          # interfaz en dist/ y servidor en dist-server/
npm start              # producción
```

Estructura:

- `server/`: API (Express + SQLite): sesiones, métricas, esquema, Portainer y monitor de webs.
- `src/`: interfaz (React + Tailwind + Recharts).
- `shared/`: tipos y valores compartidos entre ambos.
- `agent/`: script de métricas para los servidores.
