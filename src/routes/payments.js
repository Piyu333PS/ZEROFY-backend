const express = require('express')
const auth = require('../middleware/auth')
const Payment = require('../models/Payment')
const Invoice = require('../models/Invoice')

const router = express.Router()

// Invoice ka grand total nikaalo (items + tax - discount), Invoice.js jaisa hi logic
function invoiceTotal(invoice) {
  const sub = (invoice.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0)
  const afterDisc = sub - (sub * (Number(invoice.discPct) || 0) / 100)
  const withTax = afterDisc + (afterDisc * (Number(invoice.taxPct) || 0) / 100)
  return Math.round(withTax * 100) / 100
}

// ─── GET /api/payments?invoiceId=... ───────────────────────────
// Ek invoice ke saare payments (ya sabhi payments agar invoiceId nahi diya)
router.get('/', auth, async (req, res) => {
  try {
    const filter = { userId: req.user._id }
    if (req.query.invoiceId) filter.invoiceId = req.query.invoiceId

    const payments = await Payment.find(filter).sort({ date: -1, createdAt: -1 }).lean()
    res.json({ success: true, payments })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /api/payments ────────────────────────────────────────
// Naya payment record karo — invoice ka status bhi auto-update ho jayega
router.post('/', auth, async (req, res) => {
  try {
    const { invoiceId, amount, date, method, notes } = req.body
    if (!invoiceId || !amount || !date) {
      return res.status(400).json({ error: 'invoiceId, amount aur date zaroori hain' })
    }

    const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id })
    if (!invoice) return res.status(404).json({ error: 'Invoice nahi mili' })

    const payment = new Payment({
      userId: req.user._id,
      invoiceId,
      customerId: invoice.customerId || null,
      amount: Number(amount),
      date,
      method: method || 'upi',
      notes
    })
    await payment.save()

    // Ab dekho kitna total pay ho chuka hai is invoice ke liye
    const allPayments = await Payment.find({ invoiceId })
    const totalPaid = allPayments.reduce((s, p) => s + p.amount, 0)
    const total = invoiceTotal(invoice)

    let newStatus = invoice.status
    if (totalPaid >= total) newStatus = 'paid'
    else if (totalPaid > 0) newStatus = 'sent'  // partial payment — 'sent' hi rehne do, front-end alag se "partially paid" dikha sakta hai totalPaid/total compare karke

    if (newStatus !== invoice.status) {
      await Invoice.findByIdAndUpdate(invoiceId, { status: newStatus })
    }

    res.json({ success: true, payment, totalPaid, invoiceTotal: total, invoiceStatus: newStatus })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── DELETE /api/payments/:id ───────────────────────────────────
// Payment record delete karo (galti se add ho gaya ho to) — invoice status bhi recalculate hoga
router.delete('/:id', auth, async (req, res) => {
  try {
    const payment = await Payment.findOneAndDelete({ _id: req.params.id, userId: req.user._id })
    if (!payment) return res.status(404).json({ error: 'Payment nahi mila' })

    const invoice = await Invoice.findById(payment.invoiceId)
    if (invoice) {
      const remaining = await Payment.find({ invoiceId: invoice._id })
      const totalPaid = remaining.reduce((s, p) => s + p.amount, 0)
      const total = invoiceTotal(invoice)
      const newStatus = totalPaid >= total ? 'paid' : (invoice.status === 'paid' ? 'sent' : invoice.status)
      if (newStatus !== invoice.status) {
        await Invoice.findByIdAndUpdate(invoice._id, { status: newStatus })
      }
    }

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
