const express = require('express')
const auth = require('../middleware/auth')
const User = require('../models/User')
const Invoice = require('../models/Invoice')

const router = express.Router()

const FREE_LIMIT = 3

// ─── GET /api/invoices/status ─────────────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const isPro = user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date()

    if (!isPro && user.isPro) {
      await User.findByIdAndUpdate(req.user._id, { isPro: false, invoiceCount: 0 })
      user.invoiceCount = 0
      user.isPro = false
    }

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
router.post('/generate', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const isPro = user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date()

    if (!isPro && user.isPro) {
      await User.findByIdAndUpdate(req.user._id, { isPro: false, invoiceCount: 0 })
      user.invoiceCount = 0
      user.isPro = false
    }

    if (!isPro && (user.invoiceCount || 0) >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'free_limit_reached',
        message: `Free plan mein sirf ${FREE_LIMIT} invoices generate ho sakte hain. Pro upgrade karo!`,
        invoiceCount: user.invoiceCount,
        freeLimit: FREE_LIMIT
      })
    }

    await User.findByIdAndUpdate(req.user._id, { $inc: { invoiceCount: 1 } })
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

// ─── GET /api/invoices ────────────────────────────────────────
// Sabhi invoices fetch karo (us user ki)
router.get('/', auth, async (req, res) => {
  try {
    const invoices = await Invoice.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean()
    res.json({ success: true, invoices })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /api/invoices ───────────────────────────────────────
// Naya invoice save karo
router.post('/', auth, async (req, res) => {
  try {
    const data = req.body

    // Agar same invoice number pehle se hai toh update karo
    const existing = await Invoice.findOne({ userId: req.user._id, no: data.no })
    if (existing) {
      const updated = await Invoice.findByIdAndUpdate(
        existing._id,
        { ...data, userId: req.user._id },
        { new: true }
      )
      return res.json({ success: true, invoice: updated })
    }

    const invoice = new Invoice({ ...data, userId: req.user._id })
    await invoice.save()
    res.json({ success: true, invoice })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── PUT /api/invoices/:id ────────────────────────────────────
// Invoice update karo (status change, edit, etc.)
router.put('/:id', auth, async (req, res) => {
  try {
    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true }
    )
    if (!invoice) return res.status(404).json({ error: 'Invoice nahi mili' })
    res.json({ success: true, invoice })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── DELETE /api/invoices/:id ─────────────────────────────────
// Invoice delete karo
router.delete('/:id', auth, async (req, res) => {
  try {
    const invoice = await Invoice.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice nahi mili' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── GET /api/invoices/businesses ────────────────────────────
// Saved businesses fetch karo
router.get('/businesses', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean()
    res.json({ success: true, businesses: user.businesses || [] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── PUT /api/invoices/businesses ────────────────────────────
// Businesses save karo
router.put('/businesses', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { businesses: req.body.businesses })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
