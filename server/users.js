import pool from './db.js';

export async function findUserByEmail(email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  return result.rows[0] || null;
}

export async function findUserByVerificationToken(token) {
  const result = await pool.query(
    'SELECT * FROM users WHERE verification_token = $1 AND verification_token_expires > NOW()',
    [token]
  );
  return result.rows[0] || null;
}

export async function createUser(email, hashedPassword, name, verificationToken) {
  const result = await pool.query(
    `INSERT INTO users (email, name, password, verified, verification_token, verification_token_expires)
     VALUES ($1, $2, $3, FALSE, $4, NOW() + INTERVAL '24 hours')
     RETURNING *`,
    [email.toLowerCase(), name, hashedPassword, verificationToken]
  );
  return result.rows[0];
}

export async function verifyUser(userId) {
  await pool.query(
    'UPDATE users SET verified = TRUE, verification_token = NULL, verification_token_expires = NULL WHERE id = $1',
    [userId]
  );
}
