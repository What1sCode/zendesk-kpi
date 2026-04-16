import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { findUserByEmail, createUser } from './users.js';

const router = Router();

export const COOKIE_NAME = 'kpi_auth';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
};

// Password must be 8+ chars and contain uppercase, lowercase, digit, and special char
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

router.post('/signup', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, name, and password are required' });
  }

  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  if (name.trim().length < 2 || name.trim().length > 80) {
    return res.status(400).json({ error: 'Name must be 2-80 characters' });
  }

  if (!PASSWORD_REGEX.test(password)) {
    return res.status(400).json({
      error:
        'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character',
    });
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const user = await createUser(email.toLowerCase(), hashedPassword, name.trim());

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  res.json({ email: user.email, name: user.name });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await findUserByEmail(email);
  if (!user) {
    // Constant-time response to prevent user enumeration
    await bcrypt.hash('dummy', 12);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  res.json({ email: user.email, name: user.name });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, name: req.user.name });
});

export default router;
