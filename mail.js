// Sends transactional email through Resend when RESEND_API_KEY is set.
// Without a key, production logs a warning and does not send; development prints the link to the console.

const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'North Carolina Sports Report <noreply@example.invalid>';

export const mailConfigured = Boolean(KEY);

export async function sendPasswordReset(to, link) {
  const subject = 'Reset your North Carolina Sports Report password';
  const text = `We received a request to reset your password. This link works once and expires in one hour:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email. Your password stays the same.`;
  if (!KEY) {
    if (process.env.NODE_ENV !== 'production') console.log(`[dev] password reset link for ${to}: ${link}`);
    else console.warn('Password reset requested, but no email provider is configured (RESEND_API_KEY).');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`Email provider responded ${res.status}`);
}
