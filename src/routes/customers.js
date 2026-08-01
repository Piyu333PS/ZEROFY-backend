const express = require('express')
const auth = require('../middleware/auth')
const Customer = require('../models/Customer')
const Invoice = require('../models/Invoice')

const router = express.Router()

// ─── GET /api/customers ────────────────────────────────────────
// Sabhi customers fetch karo (us user ki), optionally bizId se filter
router.get('/', auth, async (req, res) => {
  try {
    const filter = { userId: req.user._id }
    if (req.query.bizId) filter.bizId = req.query.bizId

    const customers = await Customer.find(filter).sort({ name: 1 }).lean()
    res.json({ success: true, customers })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── GET /api/customers/:id ────────────────────────────────────
// Ek customer + uske invoices ki history
router.get('/:id', auth, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, userId: req.user._id }).lean()
    if (!customer) return res.status(404).json({ error: 'Customer nahi mila' })

    const invoices = await Invoice.find({ userId: req.user._id, customerId: customer._id })
      .sort({ createdAt: -1 })
      .lean()

    res.json({ success: true, customer, invoices })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /api/customers ───────────────────────────────────────
// Naya customer banao
router.post('/', auth, async (req, res) => {
  try {
    const { name, email, phone, gst, addr, notes, bizId } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'Customer ka naam zaroori hai' })

    const customer = new Customer({
      userId: req.user._id,
      name: name.trim(),
      email, phone, gst, addr, notes, bizId
    })
    await customer.save()
    res.json({ success: true, customer })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── PUT /api/customers/:id ────────────────────────────────────
// Customer update karo
router.put('/:id', auth, async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true }
    )
    if (!customer) return res.status(404).json({ error: 'Customer nahi mila' })
    res.json({ success: true, customer })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── DELETE /api/customers/:id ─────────────────────────────────
// Customer delete karo (uske invoices delete nahi honge, bas unlink ho jayenge)
router.delete('/:id', auth, async (req, res) => {
  try {
    const customer = await Customer.findOneAndDelete({ _id: req.params.id, userId: req.user._id })
    if (!customer) return res.status(404).json({ error: 'Customer nahi mila' })

    await Invoice.updateMany(
      { userId: req.user._id, customerId: customer._id },
      { $set: { customerId: null } }
    )

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
