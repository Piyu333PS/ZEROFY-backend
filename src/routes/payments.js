const express = require('express')
const auth = require('../middleware/authLite')
const Payment = require('../models/Payment')
const Invoice = require('../models/Invoice')
const { invoiceTotal, r2 } = require('../utils/invoiceCalc')
const { docTypeOf, creditMapOf, settledStatus } = require('../utils/ledger')

const router = express.Router()

const METHODS = ['upi', 'cash', 'bank_transfer', 'card', 'cheque', 'other']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Total of the credit notes raised against one invoice
async function creditedOn(invoice) {
  const notes = await Invoice.find({ userId: invoice.userId, refInvoiceId: invoice._id }).lean()
  return r2(creditMapOf(notes)[String(invoice._id)] || 0)
}

// Keep the invoice status in step with its payments and credit notes
async function syncInvoiceStatus(invoice) {
  if (invoice.status === 'cancelled' || invoice.status === 'draft') return invoice.status
  const all = await Payment.find({ invoiceId: invoice._id }).lean()
  const totalPaid = all.reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const newStatus = settledStatus(invoice, totalPaid, await creditedOn(invoice))
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
      return res.status(400).json({ error: 'Invoice and date are required' })
    }
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be more than 0' })
    if (!DATE_RE.test(String(date))) return res.status(400).json({ error: 'Date is not valid' })

    let invoice
    try {
      invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id })
    } catch { invoice = null }
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    if (docTypeOf(invoice) !== 'invoice') return res.status(400).json({ error: 'Payments can only be recorded on an invoice' })
    if (invoice.status === 'draft') return res.status(400).json({ error: 'Payments cannot be recorded on a draft. Finalise the invoice first.' })
    if (invoice.status === 'cancelled') return res.status(400).json({ error: 'Payments cannot be recorded on a cancelled invoice' })

    const total = invoiceTotal(invoice)
    const earlier = await Payment.find({ invoiceId: invoice._id }).lean()
    const alreadyPaid = earlier.reduce((s, p) => s + (Number(p.amount) || 0), 0)
    const credited = await creditedOn(invoice)
    const balance = r2(total - alreadyPaid - credited)
    if (balance <= 0) return res.status(400).json({ error: 'This invoice has no balance left to pay' })
    if (amount > balance + 0.01) {
      return res.status(400).json({ error: `Amount is more than the balance. The balance on this invoice is ${balance.toFixed(2)}.` })
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

    res.json({ success: true, payment, totalPaid, invoiceTotal: total, balance: r2(Math.max(0, total - totalPaid - credited)), invoiceStatus })
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
    if (!payment) return res.status(404).json({ error: 'Payment not found' })

    const invoice = await Invoice.findById(payment.invoiceId)
    if (invoice) await syncInvoiceStatus(invoice)

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
module.exports.syncInvoiceStatus = syncInvoiceStatus
