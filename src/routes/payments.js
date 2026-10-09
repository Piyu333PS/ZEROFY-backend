const express = require('express')
const auth = require('../middleware/authLite')
const Payment = require('../models/Payment')
const Invoice = require('../models/Invoice')
const { invoiceTotal, r2 } = require('../utils/invoiceCalc')

const router = express.Router()

const METHODS = ['upi', 'cash', 'bank_transfer', 'card', 'cheque', 'other']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Payments ke hisaab se invoice ka status theek karo
async function syncInvoiceStatus(invoice) {
  if (invoice.status === 'cancelled' || invoice.status === 'draft') return invoice.status
  const all = await Payment.find({ invoiceId: invoice._id }).lean()
  const totalPaid = all.reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const total = invoiceTotal(invoice)
  const newStatus = (totalPaid > 0 && totalPaid >= total - 0.01) ? 'paid' : 'sent'
  if (newStatus !== invoice.status) {
    await Invoice.findByIdAndUpdate(invoice._id, { status: newStatus })
  }
  return newStatus
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
    const { invoiceId, date, method, notes } = req.body
    const amount = r2(req.body.amount)
    if (!invoiceId || !date) {
      return res.status(400).json({ error: 'Invoice aur date zaroori hain' })
    }
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount 0 se zyada hona chahiye' })
    if (!DATE_RE.test(String(date))) return res.status(400).json({ error: 'Date sahi format mein nahi hai' })

    let invoice
    try {
      invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id })
    } catch { invoice = null }
    if (!invoice) return res.status(404).json({ error: 'Invoice nahi mili' })
    if (invoice.status === 'draft') return res.status(400).json({ error: 'Draft invoice par payment record nahi ho sakta — pehle invoice finalize karein' })
    if (invoice.status === 'cancelled') return res.status(400).json({ error: 'Cancelled invoice par payment record nahi ho sakta' })

    const total = invoiceTotal(invoice)
    const earlier = await Payment.find({ invoiceId: invoice._id }).lean()
    const alreadyPaid = earlier.reduce((s, p) => s + (Number(p.amount) || 0), 0)
    const balance = r2(total - alreadyPaid)
    if (balance <= 0) return res.status(400).json({ error: 'Ye invoice pehle se poora paid hai' })
    if (amount > balance + 0.01) {
      return res.status(400).json({ error: `Amount balance se zyada hai. Is invoice ka balance ${balance.toFixed(2)} hai.` })
    }

    const payment = new Payment({
      userId: req.user._id,
      invoiceId: invoice._id,
      customerId: invoice.customerId || null,
      amount,
      date,
      method: METHODS.includes(method) ? method : 'upi',
      notes: String(notes || '').slice(0, 500)
    })
    await payment.save()

    const invoiceStatus = await syncInvoiceStatus(invoice)
    const totalPaid = r2(alreadyPaid + amount)

    res.json({ success: true, payment, totalPaid, invoiceTotal: total, balance: r2(Math.max(0, total - totalPaid)), invoiceStatus })
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
    if (invoice) await syncInvoiceStatus(invoice)

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
