/**
 * Robust MySQL pool + safeQuery with automatic retry and pool recreation.
 *
 * Usage:
 *   const { safeQuery, createPool } = require('./db');
 *   createPool(); // optional (will be created lazily by safeQuery)
 *   const rows = await safeQuery("SELECT save_state FROM sessions WHERE code = ?", [code]);
 *
 * Environment variables expected:
 *   DB_HOST, DB_USER, DB_PASS, DB_NAME
 */

const mysql = require('mysql2/promise');

const TRANSIENT_ERROR_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ECONNREFUSED',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ETIMEDOUT',
  'EPIPE',
  'ER_CON_COUNT_ERROR'
]);

let pool = null;
let reconnectPromise = null;

function createPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'rossunger.com',
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // optionally set connectTimeout: 10000
  });
  return pool;
}

async function tryTestConnection(localPool) {
  const conn = await localPool.getConnection();
  conn.release();
}

/**
 * Recreate the pool. Ensures only one concurrent recreate attempt runs.
 */
async function recreatePool({ maxAttempts = 5, initialDelayMs = 200 } = {}) {
  if (reconnectPromise) {
    // wait for ongoing recreation attempt
    return reconnectPromise;
  }

  reconnectPromise = (async () => {
    console.warn('Recreating MySQL pool...');
    // Try to gracefully end old pool
    try {
      if (pool) {
        await pool.end();
      }
    } catch (err) {
      console.warn('Error while ending old pool (ignoring):', err && err.code ? err.code : err);
    } finally {
      pool = null;
    }

    // Create a fresh pool and test it (with backoff)
    const newPool = mysql.createPool({
      host: process.env.DB_HOST || 'rossunger.com',
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        await tryTestConnection(newPool);
        pool = newPool;
        console.info('MySQL pool recreated and tested (attempt', attempt + ')');
        return;
      } catch (err) {
        console.error(`Pool test attempt ${attempt} failed:`, err && err.code ? err.code : err.message || err);
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), 10000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // if we reach here, all attempts failed — close the newPool and throw
    try {
      await newPool.end();
    } catch (e) {
      // ignore
    }
    throw new Error('Failed to recreate MySQL pool after multiple attempts');
  })();

  try {
    await reconnectPromise;
  } finally {
    reconnectPromise = null;
  }
}

/**
 * safeQuery: runs a SQL query with automatic retries on transient errors.
 * Returns the rows (array).
 *
 * options:
 *   retries: number of total attempts (including the first). default 4.
 *   recreateOnTransient: whether to attempt pool recreation on transient errors. default true.
 */
async function safeQuery(sql, params = [], options = {}) {
  const retries = typeof options.retries === 'number' ? options.retries : 4;
  const recreateOnTransient = options.recreateOnTransient !== false;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      if (!pool) createPool();
      const [rows] = await pool.query(sql, params);
      return rows;
    } catch (err) {
      const code = err && err.code;
      const isTransient = Boolean(err && (err.fatal || TRANSIENT_ERROR_CODES.has(code)));

      // If we've exhausted retries or the error is non-transient -> rethrow
      if (attempt >= retries || !isTransient) {
        // Optional: if non-transient and looks like auth/db missing, surface helpful message
        console.error('DB query failed (final):', code || err.message || err);
        throw err;
      }

      console.warn(`DB query failed (attempt ${attempt}/${retries}) - code=${code || 'unknown'} - will retry`);

      // Try to heal the pool if it's a transient connection-level error
      if (recreateOnTransient) {
        try {
          await recreatePool();
        } catch (recreateErr) {
          console.error('Failed to recreate pool during retry:', recreateErr && recreateErr.message ? recreateErr.message : recreateErr);
          // Wait and then continue to next attempt (which will try createPool lazily)
        }
      }

      // Backoff before retrying
      const backoff = Math.min(200 * Math.pow(2, attempt - 1), 5000);
      await new Promise((r) => setTimeout(r, backoff));
      // loop continues -> retry
    }
  }
}

// Optional helper: convenience wrapper to fetch single row/column
async function safeGetOne(sql, params = [], options = {}) {
  const rows = await safeQuery(sql, params, options);
  if (Array.isArray(rows) && rows.length > 0) return rows[0];
  return null;
}

module.exports = {
  createPool,
  recreatePool,
  safeQuery,
  safeGetOne
};
