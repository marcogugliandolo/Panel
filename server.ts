import express from 'express';
import { createServer as createViteServer } from 'vite';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.NODE_ENV === 'production' 
  ? path.join(process.cwd(), 'database.sqlite')
  : path.join(process.cwd(), 'database.sqlite');

async function startServer() {
  const app = express();
  app.use(express.json());

  // Initialize SQLite
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS layout (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodes TEXT,
      zones TEXT
    )
  `);

  // API Routes
  app.get('/api/layout', async (req, res) => {
    try {
      const row = await db.get('SELECT * FROM layout ORDER BY id DESC LIMIT 1');
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

  app.post('/api/layout', async (req, res) => {
    try {
      const { nodes, zones } = req.body;
      await db.run('INSERT INTO layout (nodes, zones) VALUES (?, ?)', [JSON.stringify(nodes), JSON.stringify(zones)]);
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving layout:', error);
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
