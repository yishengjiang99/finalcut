import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'finalcut'
};

let pool = null;
const chatInteractionQueue = [];
let chatInteractionFlushScheduled = false;
const CHAT_INTERACTION_BATCH_SIZE = 50;
const CHAT_INTERACTION_MAX_TEXT_LENGTH = 64_000;
const CHAT_INTERACTION_TYPES = new Set(['human2ai', 'ai2human', 'error']);

function normalizeUserRow(user) {
  if (!user) return null;
  return {
    ...user,
    has_subscription: Boolean(user.has_subscription),
  };
}

// Create connection pool
export function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}

// Initialize database and create tables
export async function initDatabase() {
  try {
    const connection = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password
    });

    // Validate database name to prevent SQL injection
    const dbName = dbConfig.database;
    if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
      throw new Error('Invalid database name. Only alphanumeric characters and underscores are allowed.');
    }

    try {
      // Create database if it doesn't exist (using validated identifier)
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    } finally {
      await connection.end();
    }

    // Now create tables using the pool
    const pool = getPool();
    
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE,
        google_id VARCHAR(255) UNIQUE,
        device_install_id CHAR(36) UNIQUE,
        name VARCHAR(255),
        has_subscription BOOLEAN DEFAULT FALSE,
        subscription_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_google_id (google_id),
        INDEX idx_device_install_id (device_install_id)
      )
    `);

    // Additive migrations for databases created before anonymous iOS installs.
    await pool.query('ALTER TABLE users MODIFY email VARCHAR(255) NULL');
    try {
      await pool.query('ALTER TABLE users ADD COLUMN device_install_id CHAR(36) UNIQUE');
    } catch (error) {
      // Older MySQL/MariaDB versions do not support ADD COLUMN IF NOT EXISTS.
      if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(error.code)) throw error;
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS apple_transactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        transaction_id VARCHAR(255) NOT NULL UNIQUE,
        original_transaction_id VARCHAR(255) NOT NULL,
        product_id VARCHAR(255) NOT NULL,
        app_account_token CHAR(36),
        expires_at DATETIME NULL,
        revoked_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_apple_transactions_original (original_transaction_id),
        INDEX idx_apple_transactions_user (user_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_inference_usage (
        user_id INT NOT NULL,
        usage_date DATE NOT NULL,
        inference_count INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, usage_date),
        INDEX idx_daily_inference_usage_date (usage_date)
      )
    `);

    // Create user_lessons table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_lessons (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        lesson VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_id, created_at)
      )
    `);

    // Non-blocking audit log for chat text sent to and returned by the model.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_interactions (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NULL,
        interaction_type ENUM('human2ai', 'ai2human', 'error') NOT NULL,
        content MEDIUMTEXT NOT NULL,
        metadata JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_chat_interactions_user_created (user_id, created_at),
        INDEX idx_chat_interactions_type_created (interaction_type, created_at)
      )
    `);

    await pool.query(`
      ALTER TABLE chat_interactions
      MODIFY interaction_type ENUM('human2ai', 'ai2human', 'error') NOT NULL
    `);

    // Mobile API access tokens (Bearer). Store only SHA-256 hashes.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_api_tokens_user (user_id),
        INDEX idx_api_tokens_expires (expires_at)
      )
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

// User operations
export async function findUserByEmail(email) {
  const pool = getPool();
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  return normalizeUserRow(rows[0]);
}

export async function findUserByGoogleId(googleId) {
  const pool = getPool();
  const [rows] = await pool.query('SELECT * FROM users WHERE google_id = ?', [googleId]);
  return normalizeUserRow(rows[0]);
}

export async function findUserByDeviceInstallId(deviceInstallId) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT u.*,
       CASE WHEN u.subscription_id LIKE 'apple:%' THEN EXISTS(
         SELECT 1 FROM apple_transactions at
         WHERE at.user_id = u.id AND at.revoked_at IS NULL
           AND (at.expires_at IS NULL OR at.expires_at > UTC_TIMESTAMP())
       ) ELSE u.has_subscription END AS has_subscription
     FROM users u WHERE u.device_install_id = ?`,
    [deviceInstallId]
  );
  return normalizeUserRow(rows[0]);
}

export async function createUser(userData) {
  const pool = getPool();
  const { email = null, google_id = null, device_install_id = null, name = null, has_subscription = false } = userData;
  
  const [result] = await pool.query(
    'INSERT INTO users (email, google_id, device_install_id, name, has_subscription) VALUES (?, ?, ?, ?, ?)',
    [email, google_id, device_install_id, name, has_subscription]
  );
  
  // Fetch the complete user record from database to ensure consistency
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
  
  // Verify the user was actually inserted
  if (!rows || !rows[0]) {
    throw new Error('Failed to fetch user record after insertion');
  }
  
  return normalizeUserRow(rows[0]);
}

export async function saveAppleTransaction({
  userId,
  transactionId,
  originalTransactionId,
  productId,
  appAccountToken = null,
  expiresAt = null,
  revokedAt = null,
}) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO apple_transactions
      (user_id, transaction_id, original_transaction_id, product_id, app_account_token, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id), product_id = VALUES(product_id),
       app_account_token = VALUES(app_account_token), expires_at = VALUES(expires_at),
       revoked_at = VALUES(revoked_at)`,
    [userId, transactionId, originalTransactionId, productId, appAccountToken, expiresAt, revokedAt]
  );
}

export async function findAppleTransaction(originalTransactionId) {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT * FROM apple_transactions WHERE original_transaction_id = ? ORDER BY id DESC LIMIT 1',
    [originalTransactionId]
  );
  return rows[0] || null;
}

export async function updateUserAppleSubscription(userId, hasSubscription, subscriptionId) {
  const pool = getPool();
  await pool.query(
    `UPDATE users SET has_subscription = ?, subscription_id = ?
     WHERE id = ? AND (subscription_id IS NULL OR subscription_id LIKE 'apple:%' OR ? = 0)`,
    [hasSubscription, subscriptionId, userId, hasSubscription ? 1 : 0]
  );
}

export async function getDailyInferenceUsage(userId, dailyLimit) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT inference_count AS used,
       DATE_ADD(UTC_DATE(), INTERVAL 1 DAY) AS resets_at
     FROM daily_inference_usage
     WHERE user_id = ? AND usage_date = UTC_DATE()`,
    [userId]
  );
  const used = Number(rows[0]?.used || 0);
  return {
    limit: dailyLimit,
    used,
    remaining: Math.max(0, dailyLimit - used),
    resetsAt: rows[0]?.resets_at || new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
}

export async function consumeDailyInference(userId, dailyLimit) {
  const pool = getPool();
  if (dailyLimit <= 0) return { ...(await getDailyInferenceUsage(userId, dailyLimit)), allowed: false };

  const [result] = await pool.query(
    `INSERT INTO daily_inference_usage (user_id, usage_date, inference_count)
     VALUES (?, UTC_DATE(), 1)
     ON DUPLICATE KEY UPDATE inference_count = IF(inference_count < ?, inference_count + 1, inference_count)`,
    [userId, dailyLimit]
  );
  const usage = await getDailyInferenceUsage(userId, dailyLimit);
  return { ...usage, allowed: result.affectedRows > 0 };
}

export async function updateUserSubscription(email, hasSubscription, subscriptionId = null) {
  const pool = getPool();
  await pool.query(
    'UPDATE users SET has_subscription = ?, subscription_id = ? WHERE email = ?',
    [hasSubscription, subscriptionId, email]
  );
}

export function hashApiToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a mobile Bearer access token for a user.
 * Returns the raw token (show once) and TTL metadata.
 */
export async function createApiToken(userId, ttlMs) {
  const pool = getPool();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashApiToken(token);
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    'INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
  return { token, expiresInMs: ttlMs, expiresAt };
}

export async function findUserByApiToken(token) {
  if (typeof token !== 'string' || token.length < 32) {
    return null;
  }
  const pool = getPool();
  const tokenHash = hashApiToken(token);
  const [rows] = await pool.query(
    `SELECT u.* FROM api_tokens t
     INNER JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [tokenHash]
  );
  if (!rows[0]) return null;
  const user = rows[0];
  if (typeof user.subscription_id === 'string' && user.subscription_id.startsWith('apple:')) {
    const [entitlements] = await pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM apple_transactions at
         WHERE at.user_id = ? AND at.revoked_at IS NULL
           AND (at.expires_at IS NULL OR at.expires_at > UTC_TIMESTAMP())
       ) AS active`,
      [user.id]
    );
    user.has_subscription = Boolean(entitlements[0]?.active);
  }
  return user;
}

export async function revokeApiToken(token) {
  if (typeof token !== 'string' || token.length < 32) {
    return false;
  }
  const pool = getPool();
  const tokenHash = hashApiToken(token);
  const [result] = await pool.query('DELETE FROM api_tokens WHERE token_hash = ?', [tokenHash]);
  return result.affectedRows > 0;
}

export async function saveLesson(userId, lesson) {
  if (!lesson) return;
  try {
    const pool = getPool();
    // De-dupe: skip if same as most recent lesson for this user
    const [recent] = await pool.query(
      'SELECT lesson FROM user_lessons WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    if (recent.length > 0 && recent[0].lesson === lesson) return;
    await pool.query(
      'INSERT INTO user_lessons (user_id, lesson) VALUES (?, ?)',
      [userId, lesson]
    );
  } catch (err) {
    console.error('Failed to save lesson:', err.message);
  }
}

function normalizeChatContent(content) {
  if (typeof content === 'string') {
    return content.slice(0, CHAT_INTERACTION_MAX_TEXT_LENGTH);
  }
  if (content == null) {
    return '';
  }
  return JSON.stringify(content).slice(0, CHAT_INTERACTION_MAX_TEXT_LENGTH);
}

function scheduleChatInteractionFlush() {
  if (chatInteractionFlushScheduled) return;
  chatInteractionFlushScheduled = true;
  setImmediate(flushChatInteractionQueue);
}

/**
 * Queue chat text for asynchronous persistence.
 * This intentionally does not return a promise so request/stream handling never
 * waits on storage latency.
 */
export function enqueueChatInteraction({ userId = null, interactionType, content, metadata = null } = {}) {
  if (!CHAT_INTERACTION_TYPES.has(interactionType)) {
    console.error('Invalid chat interaction type:', interactionType);
    return;
  }

  const normalizedContent = normalizeChatContent(content).trim();
  if (!normalizedContent) return;

  chatInteractionQueue.push({
    userId,
    interactionType,
    content: normalizedContent,
    metadata,
  });
  scheduleChatInteractionFlush();
}

export async function flushChatInteractionQueue() {
  chatInteractionFlushScheduled = false;
  const batch = chatInteractionQueue.splice(0, CHAT_INTERACTION_BATCH_SIZE);
  if (batch.length === 0) return;

  try {
    const pool = getPool();
    const values = batch.map(item => [
      item.userId,
      item.interactionType,
      item.content,
      item.metadata ? JSON.stringify(item.metadata) : null,
    ]);
    await pool.query(
      'INSERT INTO chat_interactions (user_id, interaction_type, content, metadata) VALUES ?',
      [values]
    );
  } catch (err) {
    console.error('Failed to save chat interactions:', err.message);
  } finally {
    if (chatInteractionQueue.length > 0) {
      scheduleChatInteractionFlush();
    }
  }
}

export default {
  getPool,
  initDatabase,
  findUserByEmail,
  findUserByGoogleId,
  findUserByDeviceInstallId,
  createUser,
  updateUserSubscription,
  saveAppleTransaction,
  findAppleTransaction,
  updateUserAppleSubscription,
  getDailyInferenceUsage,
  consumeDailyInference,
  createApiToken,
  findUserByApiToken,
  revokeApiToken,
  saveLesson,
  enqueueChatInteraction,
  flushChatInteractionQueue,
};
