import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json());

  // Initialize SQLite database
  const db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });

  // Create table if it doesn't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS layout (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT
    )
  `);

  // API Routes
  app.get('/api/layout', async (req, res) => {
    try {
      const row = await db.get('SELECT data FROM layout ORDER BY id DESC LIMIT 1');
      if (row) {
        res.json(JSON.parse(row.data));
      } else {
        res.json(null);
      }
    } catch (error) {
      console.error('Error fetching layout:', error);
      res.status(500).json({ error: 'Failed to fetch layout' });
    }
  });

  app.post('/api/layout', async (req, res) => {
    try {
      const { nodes, zones } = req.body;
      await db.run('INSERT INTO layout (data) VALUES (?)', JSON.stringify({ nodes, zones }));
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving layout:', error);
      res.status(500).json({ error: 'Failed to save layout' });
    }
  });

  // Vite middleware for development and static serving for production
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

startServer();
