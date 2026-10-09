const express = require('express')
const auth = require('../middleware/auth')
const Invoice = require('../models/Invoice')
const Payment = require('../models/Payment')
const Customer = require('../models/Customer')
const { invoiceTotal, r2 } = require('../utils/invoiceCalc')

const router = express.Router()

// ─── GET /api/dashboard/stats ──────────────────────────────────
// "Total invoiced" mein draft aur cancelled invoices nahi gine jate —
// draft abhi bheja nahi gaya, cancelled ka paisa aana nahi hai.
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user._id

    const [invoices, payments, customerCount] = await Promise.all([
      Invoice.find({ userId }).lean(),
      Payment.find({ userId }).lean(),
      Customer.countDocuments({ userId })
    ])

    const billable = invoices.filter(inv => inv.status !== 'cancelled' && inv.status !== 'draft')
    const billableIds = new Set(billable.map(inv => String(inv._id)))
    const totalInvoiced = billable.reduce((s, inv) => s + invoiceTotal(inv), 0)

    const received = payments
      .filter(p => billableIds.has(String(p.invoiceId)))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0)
    const pending = Math.max(0, totalInvoiced - received)

    // Client count: saved clients, ya (purane data ke liye) invoices ke alag-alag client naam — jo zyada ho
    const namesOnInvoices = new Set(
      invoices.map(inv => String(inv.clientName || '').trim().toLowerCase()).filter(Boolean)
    )

    res.json({
      success: true,
      stats: {
        totalInvoiced: r2(totalInvoiced),
        received: r2(received),
        pending: r2(pending),
        invoiceCount: invoices.length,
        draftCount: invoices.filter(inv => inv.status === 'draft').length,
        customerCount: Math.max(customerCount, namesOnInvoices.size)
      }
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
