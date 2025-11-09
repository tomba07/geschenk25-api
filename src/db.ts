import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL environment variable is not set!');
  console.error('Please set DATABASE_URL in your Render environment variables.');
  throw new Error('DATABASE_URL is required');
}

console.log('Database URL configured:', databaseUrl ? `${databaseUrl.split('@')[0]}@***` : 'NOT SET');

const pool = new Pool({
  connectionString: databaseUrl,
  // Enable SSL for Render databases (required) and production
  // For local PostgreSQL, SSL will be ignored if not configured
  ssl: databaseUrl?.includes('render.com') || databaseUrl?.includes('onrender.com') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// Test connection
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

export default pool;

