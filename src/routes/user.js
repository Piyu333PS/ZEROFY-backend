const express = require('express')
const bcrypt = require('bcryptjs')
const auth = require('../middleware/auth')
const User = require('../models/User')

const router = express.Router()

// GET /api/user/me — current user info
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password')
    if (!user) return res.status(404).json({ error: 'User nahi mila' })
    const isPro = user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date()
    res.json({
      email: user.email,
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
    if (!newEmail || !password) return res.status(400).json({ error: 'Email aur password dono chahiye' })

    const user = await User.findById(req.user._id)
    if (!user) return res.status(404).json({ error: 'User nahi mila' })

    // Password verify karo
    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(400).json({ error: 'Password galat hai' })

    // Check karo naya email already exist toh nahi karta
    const existing = await User.findOne({ email: newEmail.toLowerCase() })
    if (existing) return res.status(400).json({ error: 'Ye email already use ho rahi hai' })

    user.email = newEmail.toLowerCase()
    await user.save()

    res.json({ success: true, message: 'Email update ho gayi!', email: user.email })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/user/change-password
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Dono passwords chahiye' })
    if (newPassword.length < 6) return res.status(400).json({ error: 'Naya password kam se kam 6 characters ka hona chahiye' })

    const user = await User.findById(req.user._id)
    if (!user) return res.status(404).json({ error: 'User nahi mila' })

    // Google users ke liye password nahi hoga
    if (!user.password) return res.status(400).json({ error: 'Google se login kiya hai, password change nahi ho sakta' })

    const match = await bcrypt.compare(currentPassword, user.password)
    if (!match) return res.status(400).json({ error: 'Purana password galat hai' })

    user.password = await bcrypt.hash(newPassword, 10)
    await user.save()

    res.json({ success: true, message: 'Password change ho gaya!' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
