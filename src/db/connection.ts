/**
 * PostgreSQL connection pool configuration
 */
import 'dotenv/config';
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Handle pool errors
pool.on('error', err => {
  console.error('[Database] Unexpected error on idle client', err);
});
