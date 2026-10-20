# Server Panel

Panel de control de la infraestructura propia: Raspberry Pi, VPS de Contabo y Oracle, Proxmox… Muestra el estado de cada servidor en un esquema de red, guarda su historial, controla sus contenedores a través de Portainer y vigila que las webs respondan.

## Qué hace

- **Esquema de red editable.** Añade, mueve y elimina nodos, zonas y conexiones desde el propio panel. Las conexiones se colorean según el estado del servidor al que llegan.
- **Vista de servidores.** Tarjetas con CPU, RAM, disco, contenedores y tiempo encendido; es la vista por defecto en el móvil.
- **Historial y gráficas.** Un punto por minuto y servidor, con rangos de 1 h a 30 días y vista en tabla.
- **Contenedores vía Portainer.** Estado real de todos los contenedores, arrancar, parar, reiniciar y leer logs.
- **Monitor de webs.** Comprueba cada URL a intervalos, mide el tiempo de respuesta, calcula el uptime y avisa si el certificado SSL va a caducar. Opcionalmente exige que la página contenga un texto.
- **Avisos.** Servidor sin respuesta, CPU/RAM/disco altos, contenedores caídos, webs caídas y certificados a punto de caducar. Se pueden ocultar hasta el día siguiente.
- **Acceso con sesión real.** La API entera exige iniciar sesión (cookie `HttpOnly`), con límite de intentos fallidos. Los scripts de métricas usan su propio token.

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
| `STATS_TOKEN` | vacío | Token que deben enviar los scripts de métricas. Vacío = se aceptan envíos sin token (solo mientras actualizas los scripts). Genera uno con `openssl rand -hex 32`. |
| `PORTAINER_URL` | vacío | URL de Portainer, p. ej. `https://portainer.marcogugliandolo.com`. |
| `PORTAINER_TOKEN` | vacío | Token de acceso de Portainer (**My account → Access tokens**). |
| `OFFLINE_AFTER_MINUTES` | `5` | Minutos sin recibir métricas para dar un servidor por caído. |
| `HISTORY_DAYS` | `30` | Días de historial que se conservan. |
| `PANEL_PORT` | `3000` | Puerto publicado en el host (solo en el compose). |
| `TRUST_PROXY` | redes privadas | Proxies de confianza para `X-Forwarded-*` (Nginx Proxy Manager, Traefik…). |

Con `PORTAINER_URL` y `PORTAINER_TOKEN` configurados, vincula cada servidor con su entorno de Portainer desde **Editar esquema → editar nodo**, o desde la pestaña **Contenedores** del servidor.

## Script de métricas

`agent/enviar-metricas.sh` se ejecuta en cada servidor y envía CPU, RAM, disco, tiempo encendido y el estado de todos los contenedores (también los parados). Necesita `bash`, `curl` y `jq`; Docker es opcional.

Para actualizar un servidor que ya tiene el script antiguo en `/root/monitor.sh` (la línea de cron no cambia):

```bash
sudo curl -fsSL https://raw.githubusercontent.com/marcogugliandolo/Panel/main/agent/enviar-metricas.sh -o /root/monitor.sh
sudo chmod 700 /root/monitor.sh

# Configuración de este servidor (el token, fuera del script)
sudo tee /etc/server-panel.env > /dev/null <<'EOF'
SERVER_ID=rpi-1
PANEL_URL=https://panel.marcogugliandolo.com
STATS_TOKEN=pega-aqui-el-mismo-token-del-panel
EOF
sudo chmod 600 /etc/server-panel.env

# Prueba manual
sudo /root/monitor.sh
```

En un servidor nuevo, añade a `/etc/crontab`:

```
* * * * * root /root/monitor.sh > /dev/null 2>&1
```

`SERVER_ID` tiene que coincidir con el **Id del servidor** del nodo en el esquema. Si un servidor envía datos con un id que no está en el esquema, aparece en la vista **Servidores** como «Sin ubicar en el esquema».

El panel sigue aceptando el formato del script antiguo (solo nombres de contenedores en marcha), así que se pueden actualizar los servidores de uno en uno. Cuando todos usen el script nuevo con token, define `STATS_TOKEN` en el panel.

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
