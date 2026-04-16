import pool from './db.js';

export async function findUserByEmail(email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  return result.rows[0] || null;
}

export async function createUser(email, hashedPassword, name) {
  const result = await pool.query(
    'INSERT INTO users (email, name, password) VALUES ($1, $2, $3) RETURNING *',
    [email.toLowerCase(), name, hashedPassword]
  );
  return result.rows[0];
}
