const express = require('express')
const auth = require('../middleware/auth')
const User = require('../models/User')

const router = express.Router()

const FREE_LIMIT = 3

// ─── GET /api/invoices/status ─────────────────────────────────
// Frontend check karta hai: kitne invoices bache hain
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const isPro = user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date()

    res.json({
      invoiceCount: user.invoiceCount || 0,
      freeLimit: FREE_LIMIT,
      isPro,
      canGenerate: isPro || (user.invoiceCount || 0) < FREE_LIMIT,
      remaining: isPro ? 'unlimited' : Math.max(0, FREE_LIMIT - (user.invoiceCount || 0))
    })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /api/invoices/generate ─────────────────────────────
// Invoice generate hone par call karo — count badhata hai
router.post('/generate', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const isPro = user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date()

    // Limit check
    if (!isPro && (user.invoiceCount || 0) >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'free_limit_reached',
        message: `Free plan mein sirf ${FREE_LIMIT} invoices generate ho sakte hain. Pro upgrade karo!`,
        invoiceCount: user.invoiceCount,
        freeLimit: FREE_LIMIT
      })
    }

    // Count badhao
    await User.findByIdAndUpdate(req.user._id, {
      $inc: { invoiceCount: 1 }
    })

    const updatedUser = await User.findById(req.user._id)

    res.json({
      success: true,
      invoiceCount: updatedUser.invoiceCount,
      remaining: isPro ? 'unlimited' : Math.max(0, FREE_LIMIT - updatedUser.invoiceCount)
    })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
