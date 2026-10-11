const express = require('express')
const bcrypt = require('bcryptjs')
const auth = require('../middleware/auth')
const User = require('../models/User')

const router = express.Router()

// A session that Google verified in the last hour may set a new password without the old one.
// (Google has just confirmed who the person is — that is stronger than knowing an old password.)
const GOOGLE_FRESH_MS = 60 * 60 * 1000
const googleFresh = (auth) => Boolean(auth && auth.via === 'google' && auth.gat && Date.now() - Number(auth.gat) < GOOGLE_FRESH_MS)

// GET /api/user/me — current user info
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    if (!user) return res.status(404).json({ error: 'Account not found' })
    const isPro = user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date()
    res.json({
      email: user.email,
      hasPassword: Boolean(user.password),   // Google-only accounts ke liye false
      googleSession: req.auth?.via === 'google',     // logged in with Google this time
      canSetPassword: googleFresh(req.auth),         // may set a new password without the old one
      isPro,
      proExpiry: user.proExpiry,
      lastPlanId: user.lastPlanId,
      invoiceCount: user.invoiceCount || 0,
      resumeCount: user.resumeCount || 0,
      createdAt: user.createdAt,
    })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/user/change-email
router.post('/change-email', auth, async (req, res) => {
  try {
    const { newEmail, password } = req.body
    if (!newEmail || !password) return res.status(400).json({ error: 'Email and password are both required' })

    const user = await User.findById(req.user._id)
    if (!user) return res.status(404).json({ error: 'Account not found' })

    // Google se login karne wale users ka password nahi hota
    if (!user.password) return res.status(400).json({ error: 'You log in with Google, so the email cannot be changed here' })

    // Password verify karo
    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(400).json({ error: 'Password is incorrect' })

    // Check karo naya email already exist toh nahi karta
    const existing = await User.findOne({ email: newEmail.toLowerCase() })
    if (existing) return res.status(400).json({ error: 'This email is already in use' })

    user.email = newEmail.toLowerCase()
    await user.save()

    res.json({ success: true, message: 'Email updated.', email: user.email })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/user/change-password
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are both required' })
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' })

    const user = await User.findById(req.user._id)
    if (!user) return res.status(404).json({ error: 'Account not found' })

    // Google users ke liye password nahi hoga
    if (!user.password) return res.status(400).json({ error: 'You log in with Google, so there is no password to change' })

    const match = await bcrypt.compare(currentPassword, user.password)
    if (!match) return res.status(400).json({ error: 'Current password is incorrect' })

    user.password = await bcrypt.hash(newPassword, 10)
    await user.save()

    res.json({ success: true, message: 'Password changed.' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/user/set-password  { newPassword }
// Set (or replace) the password after logging in with Google — the way back in for someone who forgot it.
router.post('/set-password', auth, async (req, res) => {
  try {
    const { newPassword } = req.body
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' })
    if (req.auth?.via !== 'google') {
      return res.status(403).json({ error: 'To set a new password without the old one, log out and log in with "Continue with Google" first.' })
    }
    if (!googleFresh(req.auth)) {
      return res.status(403).json({ error: 'For your safety, please log out and log in with Google again, then set the password within an hour.' })
    }
    const user = await User.findById(req.user._id)
    if (!user) return res.status(404).json({ error: 'Account not found' })
    user.password = await bcrypt.hash(String(newPassword), 10)
    // Any emailed reset code that was pending is no longer needed
    user.resetCodeHash = null; user.resetCodeExpiry = null
    await user.save()
    res.json({ success: true, message: 'Password saved. You can now log in with your email and this password, or with Google.' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
