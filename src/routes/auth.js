const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const nodemailer = require('nodemailer')
const { OAuth2Client } = require('google-auth-library')
const User = require('../models/User')

const router = express.Router()
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are both required' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

    const existing = await User.findOne({ email })
    if (existing) return res.status(400).json({ error: 'This email is already registered' })

    const hashed = await bcrypt.hash(password, 10)
    const user = await User.create({ email, password: hashed })

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, email: user.email, resumeCount: user.resumeCount, freeLimit: user.freeLimit, isPro: user.isPro })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    const user = await User.findOne({ email })
    if (!user) return res.status(400).json({ error: 'Email or password is incorrect' })
    if (!user.password) return res.status(400).json({ error: 'This account uses Google login. Use "Continue with Google".' })

    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(400).json({ error: 'Email or password is incorrect' })

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, email: user.email, resumeCount: user.resumeCount, freeLimit: user.freeLimit, isPro: user.isPro })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})

// Google Login (frontend se Google ID token aata hai)
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body
    if (!idToken) return res.status(400).json({ error: 'Google login did not complete. Please try again.' })

    // Google se token verify karo
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    })

    const payload = ticket.getPayload()
    const { sub: googleId, email } = payload

    // User dhundo ya naya banao
    let user = await User.findOne({ $or: [{ googleId }, { email }] })

    if (user) {
      // Pehle se email/password wala user hai, googleId link kar do
      if (!user.googleId) {
        user.googleId = googleId
        await user.save()
      }
    } else {
      // Naya user banao
      user = await User.create({ email, googleId, password: null })
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, email: user.email, resumeCount: user.resumeCount, freeLimit: user.freeLimit, isPro: user.isPro })
  } catch (err) {
    console.error('Google auth error:', err)
    res.status(401).json({ error: 'Google login failed. Please try again.' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  FORGOT PASSWORD — email par 6-digit code
// ═══════════════════════════════════════════════════════════════
// Email bhejne ke liye ye environment variables chahiye (Vercel → Settings → Environment Variables):
//   SMTP_USER  — jis email se mail jayega (jaise Gmail address)
//   SMTP_PASS  — us email ka app password (Gmail: Google Account → Security → App passwords)
//   SMTP_HOST  — optional, default smtp.gmail.com
//   SMTP_PORT  — optional, default 465
//   MAIL_FROM  — optional, default "Zerofy <SMTP_USER>"
const RESET_CODE_TTL_MS = 10 * 60 * 1000
const RESET_RESEND_GAP_MS = 60 * 1000
const RESET_MAX_ATTEMPTS = 5

const mailConfigured = () => Boolean(process.env.SMTP_USER && process.env.SMTP_PASS)
const normEmail = (v) => String(v || '').trim().toLowerCase()
const hashCode = (code, userId) =>
  crypto.createHash('sha256').update(`${code}:${userId}:${process.env.JWT_SECRET || ''}`).digest('hex')

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

const GENERIC_SENT = 'If this email is registered with Zerofy, we have sent it a 6-digit code. The code is valid for 10 minutes.'

// POST /api/auth/forgot-password  { email }
router.post('/forgot-password', async (req, res) => {
  try {
    const email = normEmail(req.body.email)
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' })
    }
    if (!mailConfigured()) {
      return res.status(503).json({
        error: 'reset_unavailable',
        message: 'Password reset is not available right now. If your email is a Google account, use "Continue with Google", or contact support.'
      })
    }

    const user = await User.findOne({ email })
    // Email registered hai ya nahi — ye bahar pata nahi chalna chahiye, isliye hamesha same jawab
    if (!user) return res.json({ success: true, message: GENERIC_SENT })

    if (user.resetCodeSentAt && Date.now() - new Date(user.resetCodeSentAt).getTime() < RESET_RESEND_GAP_MS) {
      return res.json({ success: true, message: GENERIC_SENT })
    }

    const code = String(crypto.randomInt(100000, 1000000))
    await User.findByIdAndUpdate(user._id, {
      resetCodeHash: hashCode(code, user._id),
      resetCodeExpiry: new Date(Date.now() + RESET_CODE_TTL_MS),
      resetCodeSentAt: new Date(),
      resetCodeAttempts: 0,
    })

    try {
      await getTransporter().sendMail({
        from: process.env.MAIL_FROM || `Zerofy <${process.env.SMTP_USER}>`,
        to: user.email,
        subject: `${code} — Zerofy password reset code`,
        text: `Your Zerofy password reset code: ${code}\n\nThis code is valid for 10 minutes. If you did not ask to reset your password, ignore this email. Your account is safe.\n\n— Zerofy`,
        html: `<div style="font-family:Arial,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1B2340">
          <h2 style="margin:0 0 12px">Zerofy password reset</h2>
          <p style="margin:0 0 16px;color:#4B5566">Enter this code to set a new password:</p>
          <div style="font-size:30px;font-weight:700;letter-spacing:8px;background:#F7F3EA;border:1px solid #E1D9C4;border-radius:10px;padding:14px;text-align:center">${code}</div>
          <p style="margin:16px 0 0;color:#69708A;font-size:13px">This code is valid for 10 minutes. If you did not request this, ignore this email. Your account is safe.</p>
        </div>`,
      })
    } catch (mailErr) {
      console.error('Reset mail error:', mailErr)
      await User.findByIdAndUpdate(user._id, { resetCodeHash: null, resetCodeExpiry: null, resetCodeSentAt: null })
      return res.status(502).json({ error: 'Could not send the email. Please try again in a little while.' })
    }

    res.json({ success: true, message: GENERIC_SENT })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/auth/reset-password  { email, code, newPassword }
router.post('/reset-password', async (req, res) => {
  try {
    const email = normEmail(req.body.email)
    const code = String(req.body.code || '').trim()
    const newPassword = String(req.body.newPassword || '')
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Email, code and new password are all required' })
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' })

    const INVALID = 'The code is wrong or has expired. Request a new code.'
    const user = await User.findOne({ email })
    if (!user || !user.resetCodeHash || !user.resetCodeExpiry) return res.status(400).json({ error: INVALID })
    if (new Date(user.resetCodeExpiry).getTime() < Date.now()) return res.status(400).json({ error: INVALID })
    if ((user.resetCodeAttempts || 0) >= RESET_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' })
    }

    const expected = Buffer.from(String(user.resetCodeHash), 'hex')
    const given = Buffer.from(hashCode(code, user._id), 'hex')
    const match = expected.length === given.length && crypto.timingSafeEqual(expected, given)
    if (!match) {
      await User.findByIdAndUpdate(user._id, { $inc: { resetCodeAttempts: 1 } })
      return res.status(400).json({ error: INVALID })
    }

    await User.findByIdAndUpdate(user._id, {
      password: await bcrypt.hash(newPassword, 10),
      resetCodeHash: null, resetCodeExpiry: null, resetCodeSentAt: null, resetCodeAttempts: 0,
    })
    res.json({ success: true, message: 'Password changed. Log in with your new password.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
