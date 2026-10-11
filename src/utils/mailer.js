// One place that sends email (password reset codes, plan reminders).
// Settings (Vercel → Environment Variables):
//   SMTP_USER  — the mailbox mail is sent from (for example a Gmail address)
//   SMTP_PASS  — its app password
//   SMTP_HOST / SMTP_PORT — optional, default smtp.gmail.com / 465
//   MAIL_FROM  — optional, default "Zerofy <SMTP_USER>"
//   MAIL_REPLY_TO — optional, default support@zerofy.co.in
const nodemailer = require('nodemailer')

const mailConfigured = () => Boolean(process.env.SMTP_USER && process.env.SMTP_PASS)

let transporter = null
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 465
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  }
  return transporter
}

// A plain, friendly HTML wrapper so every Zerofy mail looks the same
const layout = (title, bodyHtml) => `<div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto;padding:24px;color:#12263F">
  <div style="font-size:13px;font-weight:700;letter-spacing:3px;color:#A85E08;margin-bottom:14px">ZEROFY</div>
  <h2 style="margin:0 0 12px;font-size:20px">${title}</h2>
  ${bodyHtml}
  <p style="margin:22px 0 0;color:#8494A6;font-size:12px">Zerofy · GST billing and invoicing · www.zerofy.co.in</p>
</div>`

async function sendMail({ to, subject, text, html }) {
  return getTransporter().sendMail({
    from: process.env.MAIL_FROM || `Zerofy <${process.env.SMTP_USER}>`,
    // Replies go to the support address even when the mail is sent from another mailbox
    replyTo: process.env.MAIL_REPLY_TO || 'support@zerofy.co.in',
    to, subject, text, html,
  })
}

module.exports = { mailConfigured, sendMail, layout }
