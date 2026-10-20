import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createAuth, requireStatsToken } from './auth';
import { config } from './config';
import { openDatabase, pruneHistory } from './db';
import { createMonitorService } from './monitors';
import { createLayoutRouter } from './routes/layout';
import { createPortainerRouter } from './routes/portainer';
import { createIngestHandler, createStatsRouter } from './routes/stats';

async function main() {
  const db = openDatabase();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '512kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (config.isProduction) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    }
    next();
  });

  const auth = createAuth(db);
  const monitors = createMonitorService(db);

  // Rutas públicas
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth', auth.router);
  // Los scripts de métricas envían aquí (token propio, sin sesión).
  app.post('/api/stats/:id', requireStatsToken, createIngestHandler(db));

  // A partir de aquí, todo exige sesión.
  app.use('/api', auth.requireAuth);
  app.use('/api/stats', createStatsRouter(db));
  app.use('/api/layout', createLayoutRouter(db));
  app.use('/api/portainer', createPortainerRouter());
  app.use('/api/monitors', monitors.router);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if ((error as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'JSON no válido' });
      return;
    }
    console.error('[server] Error no controlado:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  if (config.isProduction) {
    const distPath = path.join(process.cwd(), 'dist');
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      console.error('[server] No existe dist/index.html. Ejecuta "npm run build" antes de arrancar en producción.');
    }
    app.use(express.static(distPath, { index: false, maxAge: '7d' }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  pruneHistory(db);
  setInterval(() => pruneHistory(db), 3_600_000).unref();
  monitors.start();

  if (!config.statsToken) {
    console.warn('[stats] STATS_TOKEN no está definido: se aceptan métricas de cualquiera. Configúralo cuando actualices los scripts.');
  }
  if (!config.portainerUrl || !config.portainerToken) {
    console.warn('[portainer] PORTAINER_URL o PORTAINER_TOKEN sin definir: el control de contenedores estará desactivado.');
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] Panel escuchando en http://0.0.0.0:${config.port} (${config.isProduction ? 'producción' : 'desarrollo'})`);
  });
}

main().catch((error) => {
  console.error('[server] No se pudo arrancar:', error);
  process.exit(1);
});
