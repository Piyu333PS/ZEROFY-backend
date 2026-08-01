const express = require('express')
const auth = require('../middleware/auth')
const Invoice = require('../models/Invoice')
const Payment = require('../models/Payment')
const Customer = require('../models/Customer')

const router = express.Router()

function invoiceTotal(invoice) {
  const sub = (invoice.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0)
  const afterDisc = sub - (sub * (Number(invoice.discPct) || 0) / 100)
  const withTax = afterDisc + (afterDisc * (Number(invoice.taxPct) || 0) / 100)
  return Math.round(withTax * 100) / 100
}

// ─── GET /api/dashboard/stats ──────────────────────────────────
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user._id

    const [invoices, payments, customerCount] = await Promise.all([
      Invoice.find({ userId }).lean(),
      Payment.find({ userId }).lean(),
      Customer.countDocuments({ userId })
    ])

    const totalInvoiced = invoices
      .filter(inv => inv.status !== 'cancelled')
      .reduce((s, inv) => s + invoiceTotal(inv), 0)

    const received = payments.reduce((s, p) => s + p.amount, 0)
    const pending = Math.max(0, totalInvoiced - received)

    res.json({
      success: true,
      stats: {
        totalInvoiced: Math.round(totalInvoiced * 100) / 100,
        received: Math.round(received * 100) / 100,
        pending: Math.round(pending * 100) / 100,
        invoiceCount: invoices.length,
        customerCount
      }
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
