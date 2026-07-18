const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'LoopBack <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

async function sendPasswordResetEmail(toEmail, rawToken) {
  if (!resend) {
    // No API key configured -- log instead of sending, so local dev without
    // an email service configured doesn't hard-fail. Makes the link visible
    // in the server console for testing.
    console.warn(`RESEND_API_KEY not set. Password reset link for ${toEmail}:`);
    console.warn(`${APP_URL}/reset-password.html?token=${rawToken}`);
    return;
  }

  const resetUrl = `${APP_URL}/reset-password.html?token=${rawToken}`;

  await resend.emails.send({
    from: EMAIL_FROM,
    to: toEmail,
    subject: 'Reset your LoopBack password',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1a1c27;">Reset your password</h2>
        <p>Someone requested a password reset for your LoopBack account. If this was you, click below to set a new password. This link expires in 1 hour.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background: #ff9f5a; color: #1a1206; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600;">Reset password</a>
        </p>
        <p style="color: #8b8da3; font-size: 13px;">If you didn't request this, you can safely ignore this email -- your password won't change.</p>
      </div>
    `,
  });
}

module.exports = { sendPasswordResetEmail };