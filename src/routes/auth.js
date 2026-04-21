const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const User = require('../models/User')

const router = express.Router()

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

    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(400).json({ error: 'Email ya password galat hai' })

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, email: user.email, resumeCount: user.resumeCount, freeLimit: user.freeLimit, isPro: user.isPro })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
