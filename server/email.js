import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.RESEND_FROM_EMAIL || 'noreply@elotouch.com';
const APP_URL = process.env.APP_URL || 'https://zendesk-kpi-production.up.railway.app';

export async function sendVerificationEmail(email, name, token) {
  const link = `${APP_URL}/api/auth/verify?token=${token}`;

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Verify your Zendesk KPI Dashboard account',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1e293b;">Welcome to the KPI Dashboard, ${name}</h2>
        <p style="color: #475569;">Click the button below to verify your email address and activate your account.</p>
        <p style="color: #475569;">This link expires in 24 hours.</p>
        <a href="${link}"
           style="display: inline-block; margin: 16px 0; padding: 12px 24px;
                  background: #2563eb; color: #fff; text-decoration: none;
                  border-radius: 6px; font-weight: 600;">
          Verify Email Address
        </a>
        <p style="color: #94a3b8; font-size: 12px;">
          If you didn't create this account, you can ignore this email.
        </p>
        <p style="color: #94a3b8; font-size: 12px;">
          Or copy this link: ${link}
        </p>
      </div>
    `,
  });
}
