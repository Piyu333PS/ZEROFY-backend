const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { OAuth2Client } = require('google-auth-library')
const User = require('../models/User')

const router = express.Router()
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email aur password dono chahiye' })
    if (password.length < 6) return res.status(400).json({ error: 'Password kam se kam 6 characters ka hona chahiye' })

    const existing = await User.findOne({ email })
    if (existing) return res.status(400).json({ error: 'Ye email pehle se registered hai' })

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
    if (!user) return res.status(400).json({ error: 'Email ya password galat hai' })
    if (!user.password) return res.status(400).json({ error: 'Is account mein Google se login karo' })

    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(400).json({ error: 'Email ya password galat hai' })

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
    if (!idToken) return res.status(400).json({ error: 'Google token nahi mila' })

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
    res.status(401).json({ error: 'Google login fail hua, dobara try karo' })
  }
})

module.exports = router
