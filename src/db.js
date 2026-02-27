import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'finalcut'
};

let pool = null;

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
        email VARCHAR(255) NOT NULL UNIQUE,
        google_id VARCHAR(255) UNIQUE,
        name VARCHAR(255),
        has_subscription BOOLEAN DEFAULT FALSE,
        subscription_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_google_id (google_id)
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
  return rows[0] || null;
}

export async function findUserByGoogleId(googleId) {
  const pool = getPool();
  const [rows] = await pool.query('SELECT * FROM users WHERE google_id = ?', [googleId]);
  return rows[0] || null;
}

export async function createUser(userData) {
  const pool = getPool();
  const { email, google_id, name, has_subscription = false } = userData;
  
  const [result] = await pool.query(
    'INSERT INTO users (email, google_id, name, has_subscription) VALUES (?, ?, ?, ?)',
    [email, google_id, name, has_subscription]
  );
  
  // Fetch the complete user record from database to ensure consistency
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
  
  // Verify the user was actually inserted
  if (!rows || !rows[0]) {
    throw new Error('Failed to fetch user record after insertion');
  }
  
  return rows[0];
}

export async function updateUserSubscription(email, hasSubscription, subscriptionId = null) {
  const pool = getPool();
  await pool.query(
    'UPDATE users SET has_subscription = ?, subscription_id = ? WHERE email = ?',
    [hasSubscription, subscriptionId, email]
  );
}

// Lesson operations
export async function getRecentLessons(userId, limit = 7) {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT lesson FROM user_lessons WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]
    );
    return rows.map(r => r.lesson);
  } catch (err) {
    console.error('Failed to load lessons:', err.message);
    return [];
  }
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

export default {
  getPool,
  initDatabase,
  findUserByEmail,
  findUserByGoogleId,
  createUser,
  updateUserSubscription,
  getRecentLessons,
  saveLesson,
};
