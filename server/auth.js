import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { findUserByEmail, findUserById, findUserByVerificationToken, createUser, verifyUser } from './users.js';
import { sendVerificationEmail, sendAdminSignupNotification } from './email.js';

const router = Router();

export const COOKIE_NAME = 'kpi_auth';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000,
};

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_DOMAIN = 'elotouch.com';

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verify user still exists and is verified in the database
    const user = await findUserById(decoded.id);
    if (!user || !user.verified) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'Unauthorized' });
    }

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

  // Enforce elotouch.com domain
  const domain = email.split('@')[1]?.toLowerCase();
  if (domain !== ALLOWED_DOMAIN) {
    return res.status(403).json({ error: 'Only @elotouch.com email addresses are allowed' });
  }

  if (name.trim().length < 2 || name.trim().length > 80) {
    return res.status(400).json({ error: 'Name must be 2-80 characters' });
  }

  if (!PASSWORD_REGEX.test(password)) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character',
    });
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const verificationToken = crypto.randomBytes(32).toString('hex');

  const user = await createUser(email.toLowerCase(), hashedPassword, name.trim(), verificationToken);

  try {
    await sendVerificationEmail(user.email, user.name, verificationToken);
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
  }

  try {
    await sendAdminSignupNotification(user.email, user.name);
  } catch (err) {
    console.error('Failed to send admin notification:', err.message);
  }

  res.status(201).json({
    message: 'Account created. Please check your email to verify your account before signing in.',
  });
});

// GET — show confirmation page only, do NOT verify yet (prevents email scanner auto-verification)
router.get('/verify', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send(verifyConfirmPage(null, 'Invalid verification link.', false));
  }

  const user = await findUserByVerificationToken(token);
  if (!user) {
    return res.status(400).send(verifyConfirmPage(null, 'This verification link is invalid or has expired. Please sign up again.', false));
  }

  if (user.verified) {
    return res.send(verifyConfirmPage(null, 'Your email is already verified. You can sign in.', true));
  }

  // Show page with confirm button — actual verification happens on POST
  res.send(verifyConfirmPage(token, null, null));
});

// POST — user clicked the confirm button, now actually verify
router.post('/verify', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).send(verifyConfirmPage(null, 'Invalid verification link.', false));
  }

  const user = await findUserByVerificationToken(token);
  if (!user) {
    return res.status(400).send(verifyConfirmPage(null, 'This verification link is invalid or has expired. Please sign up again.', false));
  }

  if (user.verified) {
    return res.send(verifyConfirmPage(null, 'Your email is already verified. You can sign in.', true));
  }

  await verifyUser(user.id);
  res.send(verifyConfirmPage(null, 'Email verified! Your account is now active. You can sign in.', true));
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await findUserByEmail(email);
  if (!user) {
    await bcrypt.hash('dummy', 12);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.verified) {
    return res.status(403).json({ error: 'Please verify your email before signing in. Check your inbox for the verification link.' });
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

// If token is provided: show confirm button (requires user click to POST)
// If message is provided: show result message
function verifyConfirmPage(token, message, success) {
  const APP_URL = process.env.APP_URL || 'https://zendesk-kpi-production.up.railway.app';

  if (token) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Email — Zendesk KPI Dashboard</title>
  <style>
    body { font-family: sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.1); padding: 40px; max-width: 420px; text-align: center; }
    h2 { color: #1e293b; margin: 0 0 8px; }
    p { color: #475569; margin: 0 0 24px; }
    button { padding: 12px 32px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Zendesk KPI Dashboard</h2>
    <p>Click the button below to verify your email address and activate your account.</p>
    <form method="POST" action="${APP_URL}/api/auth/verify">
      <input type="hidden" name="token" value="${token}" />
      <button type="submit">Confirm Email Address</button>
    </form>
  </div>
</body>
</html>`;
  }

  const color = success ? '#16a34a' : '#dc2626';
  const icon = success ? '✓' : '✗';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Verification — Zendesk KPI Dashboard</title>
  <style>
    body { font-family: sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.1); padding: 40px; max-width: 420px; text-align: center; }
    .icon { font-size: 48px; color: ${color}; }
    h2 { color: #1e293b; margin: 16px 0 8px; }
    p { color: #475569; }
    a { display: inline-block; margin-top: 24px; padding: 10px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h2>Zendesk KPI Dashboard</h2>
    <p>${message}</p>
    <a href="/">Go to Dashboard</a>
  </div>
</body>
</html>`;
}

export default router;
