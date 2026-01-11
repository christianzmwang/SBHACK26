import pg from 'pg';
import pgvector from 'pgvector/pg';

const { Pool } = pg;

// Create connection pool (lazy initialization)
let pool = null;
let vectorRegistered = false;

export const getPool = () => {
  if (!pool && process.env.DATABASE_URL) {
    // Parse the connection string to check for pooler mode
    const isPoolerConnection = process.env.DATABASE_URL.includes('pooler') || 
                                process.env.DATABASE_URL.includes('6543') ||
                                process.env.DB_POOLER_MODE === 'true';
    
    const dbConfig = {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: isPoolerConnection ? 5 : 10, // Fewer connections for pooler mode
      min: 0, // Don't hold idle connections
      idleTimeoutMillis: isPoolerConnection ? 1000 : 5000, // Close idle connections faster for pooler
      connectionTimeoutMillis: 60000, // Increased to 60s for cold starts/hibernation
      statement_timeout: 60000,
      query_timeout: 60000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000, // More aggressive keep-alive
      allowExitOnIdle: true,
    };

    pool = new Pool(dbConfig);
    
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      // Reset pool on severe errors to force fresh connections
      if (err.message?.includes('Connection terminated') || 
          err.message?.includes('connection timeout')) {
        console.log('Resetting pool due to connection error...');
        pool = null;
      }
    });

    pool.on('connect', (client) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('Database pool: new client connected');
      }
      // Set per-connection timeout for serverless databases
      client.query('SET statement_timeout = 55000').catch(() => {});
    });
  }
  return pool;
};

// Initialize database with pgvector extension (with retry logic)
export const initializeDatabase = async () => {
  const pool = getPool();
  
  if (!pool) {
    console.warn('Database not configured - DATABASE_URL not set');
    return false;
  }
  
  const maxRetries = 5;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let client = null;
    
    try {
      client = await pool.connect();
      
      // Create vector extension if not exists
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      
      // Register pgvector type on client
      await pgvector.registerType(client);
      vectorRegistered = true;
      
      console.log('Database initialized with pgvector support');
      return true;
    } catch (error) {
      console.error(`Database init attempt ${attempt + 1}/${maxRetries} failed:`, error.message);
      
      if (attempt < maxRetries - 1) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    } finally {
      if (client) {
        client.release();
      }
    }
  }
  
  console.error('Failed to initialize database after all retries');
  return false;
};

// Retry helper for database operations
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const withDbRetry = async (fn, maxRetries = 3) => {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if error is retryable (connection issues, not query syntax errors)
      const isRetryable = 
        error.code === 'ECONNREFUSED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET' ||
        error.code === '57P01' || // admin_shutdown
        error.code === '57P02' || // crash_shutdown  
        error.code === '57P03' || // cannot_connect_now
        error.code === '08006' || // connection_failure
        error.code === '08001' || // sqlclient_unable_to_establish_sqlconnection
        error.code === '08004' || // sqlserver_rejected_establishment_of_sqlconnection
        error.message?.includes('Connection terminated') ||
        error.message?.includes('connection timeout') ||
        error.message?.includes('too many clients') ||
        error.message?.includes('sorry, too many clients') ||
        error.message?.includes('remaining connection slots');
      
      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }
      
      // Reset pool on connection errors to force fresh connection
      if (error.message?.includes('Connection terminated') || 
          error.message?.includes('connection timeout')) {
        console.log('Resetting pool to get fresh connections...');
        pool = null;
      }
      
      const delay = Math.min(2000 * Math.pow(2, attempt), 10000);
      console.warn(`Database retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms:`, error.message);
      await sleep(delay);
    }
  }
  
  throw lastError;
};

// Execute query with error handling and retry
export const query = async (text, params) => {
  const pool = getPool();
  
  if (!pool) {
    throw new Error('Database not configured. Please set DATABASE_URL in your .env file');
  }
  
  return withDbRetry(async () => {
    const start = Date.now();
    
    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - start;
      
      if (process.env.NODE_ENV === 'development') {
        console.log('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
      }
      
      return result;
    } catch (error) {
      console.error('Database query error:', error.message);
      throw error;
    }
  });
};

// Transaction helper
export const transaction = async (callback) => {
  const pool = getPool();
  
  if (!pool) {
    throw new Error('Database not configured. Please set DATABASE_URL in your .env file');
  }
  
  const client = await pool.connect();
  
  try {
    // Register vector type if needed
    if (!vectorRegistered) {
      try {
        await pgvector.registerType(client);
        vectorRegistered = true;
      } catch (e) {
        // Ignore if already registered
      }
    }
    
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// Test database connectivity (useful for debugging)
export const testConnection = async () => {
  const pool = getPool();
  
  if (!pool) {
    return { success: false, error: 'DATABASE_URL not configured' };
  }
  
  const start = Date.now();
  
  try {
    const result = await pool.query('SELECT NOW() as time, version() as version');
    const duration = Date.now() - start;
    
    return { 
      success: true, 
      latency: duration,
      serverTime: result.rows[0].time,
      version: result.rows[0].version.split(' ')[0] + ' ' + result.rows[0].version.split(' ')[1]
    };
  } catch (error) {
    return { 
      success: false, 
      error: error.message,
      code: error.code,
      latency: Date.now() - start
    };
  }
};

export default { getPool, initializeDatabase, query, transaction, testConnection };
