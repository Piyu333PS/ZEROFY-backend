const express = require('express')
const auth = require('../middleware/authLite')
const Invoice = require('../models/Invoice')
const Payment = require('../models/Payment')
const Customer = require('../models/Customer')
const User = require('../models/User')
const Item = require('../models/Item')
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

const FREE_LIMIT = 3

// ─── GET /api/dashboard/bootstrap ──────────────────────────────
// Billing app ka poora data EK request mein: businesses, invoices, clients, payments,
// saved items, stats aur plan status. Pehle har page 2–4 alag requests bhejta tha aur
// har request 1–2 second leti thi; ab sab queries ek saath (parallel) chalti hain.
router.get('/bootstrap', auth, async (req, res) => {
  try {
    const userId = req.user._id
    let [user, invoices, payments, customers, items] = await Promise.all([
      User.findById(userId).lean(),
      Invoice.find({ userId }).sort({ createdAt: -1 }).lean(),
      Payment.find({ userId }).sort({ date: -1, createdAt: -1 }).lean(),
      Customer.find({ userId }).sort({ name: 1 }).lean(),
      Item.find({ userId }).sort({ name: 1 }).lean(),
    ])
    if (!user) return res.status(401).json({ error: 'User nahi mila' })

    // Purane invoices jinke client abhi Clients list mein nahi hain — unhe yahin jod do
    const orphans = invoices.filter(inv => !inv.customerId && String(inv.clientName || '').trim())
    if (orphans.length) {
      try {
        const byName = {}
        for (const c of customers) byName[String(c.name || '').trim().toLowerCase()] = c._id
        for (const inv of orphans) {
          const name = String(inv.clientName).trim()
          const key = name.toLowerCase()
          if (!byName[key]) {
            const created = new Customer({
              userId, bizId: inv.bizId || null, name,
              email: inv.clientEmail || '', phone: inv.clientPhone || '',
              gst: inv.clientGst || '', addr: inv.clientAddr || ''
            })
            await created.save()
            byName[key] = created._id
            customers.push(created.toObject())
          }
          await Invoice.findByIdAndUpdate(inv._id, { customerId: byName[key] })
          inv.customerId = byName[key]
        }
        customers.sort((a, b) => String(a.name).localeCompare(String(b.name)))
      } catch (e) {
        console.error('Customer backfill error:', e)
      }
    }

    const paidByInvoice = {}
    for (const p of payments) {
      const k = String(p.invoiceId)
      paidByInvoice[k] = (paidByInvoice[k] || 0) + (Number(p.amount) || 0)
    }

    const agg = {}
    let totalInvoiced = 0, received = 0
    const outInvoices = invoices.map(inv => {
      const total = invoiceTotal(inv)
      const paid = r2(paidByInvoice[String(inv._id)] || 0)
      if (inv.status !== 'cancelled' && inv.status !== 'draft') {
        totalInvoiced += total
        received += paid
        if (inv.customerId) {
          const k = String(inv.customerId)
          if (!agg[k]) agg[k] = { invoiceCount: 0, billed: 0, received: 0 }
          agg[k].invoiceCount += 1
          agg[k].billed += total
          agg[k].received += paid
        }
      }
      // Logo yahan nahi bhejte — frontend use business profile se jod leta hai
      const { bizLogo, ...rest } = inv
      return { ...rest, grandTotal: total, paidAmount: paid, balance: r2(Math.max(0, total - paid)) }
    })

    const outCustomers = customers.map(c => {
      const a = agg[String(c._id)] || { invoiceCount: 0, billed: 0, received: 0 }
      return { ...c, invoiceCount: a.invoiceCount, billed: r2(a.billed), received: r2(a.received), outstanding: r2(Math.max(0, a.billed - a.received)) }
    })

    const isPro = Boolean(user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date())
    const invoiceCount = (!isPro && user.isPro) ? 0 : (user.invoiceCount || 0)

    res.json({
      success: true,
      businesses: user.businesses || [],
      invoices: outInvoices,
      customers: outCustomers,
      payments,
      items,
      stats: {
        totalInvoiced: r2(totalInvoiced),
        received: r2(received),
        pending: r2(Math.max(0, totalInvoiced - received)),
        invoiceCount: invoices.length,
        draftCount: invoices.filter(inv => inv.status === 'draft').length,
        customerCount: customers.length,
      },
      status: {
        invoiceCount,
        freeLimit: FREE_LIMIT,
        isPro,
        canGenerate: isPro || invoiceCount < FREE_LIMIT,
        remaining: isPro ? 'unlimited' : Math.max(0, FREE_LIMIT - invoiceCount),
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
