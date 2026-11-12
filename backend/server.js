// BITA backend: starts the server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Websites allowed to call this API. Add your live site address in backend/.env:
// ALLOWED_ORIGINS=http://127.0.0.1:5500,https://yourname.github.io
const allowed = (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:5500,http://localhost:5500')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: allowed }));
app.use(express.json({ limit: '100kb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(500).json({ ok: false, db: 'error' });
  }
});

app.use('/api/products', require('./products'));
app.use('/api/orders', require('./orders'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Bad requests (for example broken JSON) get a clean answer instead of a stack trace
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => console.log(`BITA backend running on http://localhost:${PORT}`));