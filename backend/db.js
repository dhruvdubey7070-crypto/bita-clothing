// Database connection (Supabase PostgreSQL)
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add it to backend/.env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase pooler needs SSL
  max: 5,
});

pool.on('error', (err) => console.error('Database connection error:', err.message));

module.exports = pool;