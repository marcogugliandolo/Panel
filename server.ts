import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const PORT = Number(process.env.PORT) || 3000;

// Asegurar que el directorio data existe para el volumen de Docker
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const DB_PATH = path.join(dataDir, 'database.sqlite');

async function startServer() {
  const app = express();
  app.use(express.json());

  // Initialize SQLite
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS layout (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodes TEXT,
      zones TEXT
    );
    CREATE TABLE IF NOT EXISTS server_stats (
      server_id TEXT PRIMARY KEY,
      cpu_usage REAL,
      ram_usage REAL,
      apps_total INTEGER,
      apps_running INTEGER,
      container_list TEXT,
      last_updated INTEGER
    );
  `);

  // Migración simple si la columna no existe
  try {
    db.prepare('ALTER TABLE server_stats ADD COLUMN container_list TEXT').run();
  } catch (e) {
    // La columna ya existe
  }

  // --- API Routes for Layout ---
  app.get('/api/layout', (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM layout ORDER BY id DESC LIMIT 1').get() as any;
      if (row) {
        res.json({ nodes: JSON.parse(row.nodes), zones: JSON.parse(row.zones) });
      } else {
        res.json({ nodes: null, zones: null });
      }
    } catch (error) {
      console.error('Error fetching layout:', error);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.post('/api/layout', (req, res) => {
    try {
      const { nodes, zones } = req.body;
      db.prepare('INSERT INTO layout (nodes, zones) VALUES (?, ?)').run(JSON.stringify(nodes), JSON.stringify(zones));
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving layout:', error);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // --- API Routes for Server Stats ---
  app.get('/api/debug/db', (req, res) => {
    try {
      const stats = db.prepare('SELECT * FROM server_stats').all();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/stats', (req, res) => {
    try {
      const stats = db.prepare('SELECT * FROM server_stats').all();
      // Parsear container_list de string a array
      const parsedStats = stats.map((s: any) => {
        let containers = [];
        try {
          containers = s.container_list ? JSON.parse(s.container_list) : [];
          if (!Array.isArray(containers)) containers = [];
        } catch (e) {
          console.error(`Error parsing container_list for ${s.server_id}:`, e);
        }
        return {
          ...s,
          container_list: containers
        };
      });
      console.log(`[GET STATS] Enviando ${parsedStats.length} estadísticas`);
      res.json(parsedStats);
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.post('/api/stats/:id', (req, res) => {
    try {
      const serverId = req.params.id;
      const { cpu, ram, appsTotal, appsRunning, containerList, container_list } = req.body;
      const finalContainerList = containerList || container_list || [];
      const now = Date.now();

      console.log(`[POST STATS] Recibido de ${serverId}:`, { 
        cpu, 
        ram, 
        appsTotal, 
        appsRunning, 
        containers: Array.isArray(finalContainerList) ? finalContainerList.length : 'not an array'
      });

      db.prepare(`
        INSERT INTO server_stats (server_id, cpu_usage, ram_usage, apps_total, apps_running, container_list, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          cpu_usage = excluded.cpu_usage,
          ram_usage = excluded.ram_usage,
          apps_total = excluded.apps_total,
          apps_running = excluded.apps_running,
          container_list = excluded.container_list,
          last_updated = excluded.last_updated
      `).run(serverId, cpu, ram, appsTotal, appsRunning, JSON.stringify(finalContainerList), now);

      res.json({ success: true });
    } catch (error) {
      console.error('Error saving stats:', error);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(console.error);
