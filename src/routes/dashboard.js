const express = require('express')
const auth = require('../middleware/authLite')
const Invoice = require('../models/Invoice')
const Payment = require('../models/Payment')
const Customer = require('../models/Customer')
const User = require('../models/User')
const Item = require('../models/Item')
const { buildLedger } = require('../utils/ledger')

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

    const ledger = buildLedger(invoices, payments)
    const onlyInvoices = ledger.invoices

    // Client count: saved clients, ya (purane data ke liye) invoices ke alag-alag client naam — jo zyada ho
    const namesOnInvoices = new Set(
      onlyInvoices.map(inv => String(inv.clientName || '').trim().toLowerCase()).filter(Boolean)
    )

    res.json({
      success: true,
      stats: {
        ...ledger.totals,
        invoiceCount: onlyInvoices.length,
        draftCount: onlyInvoices.filter(inv => inv.status === 'draft').length,
        quotationCount: ledger.quotations.length,
        creditNoteCount: ledger.creditNotes.length,
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
    if (!user) return res.status(401).json({ error: 'Account not found' })

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

    const ledger = buildLedger(invoices, payments)
    // The logo is not sent with each document — the app adds it from the business profile
    const strip = ({ bizLogo, ...rest }) => rest
    const outInvoices = ledger.invoices.map(strip)
    const outCustomers = customers.map(c => {
      const a = ledger.byCustomer[String(c._id)] || { invoiceCount: 0, billed: 0, received: 0, outstanding: 0 }
      return { ...c, invoiceCount: a.invoiceCount, billed: a.billed, received: a.received, outstanding: a.outstanding }
    })

    const isPro = Boolean(user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date())
    const invoiceCount = (!isPro && user.isPro) ? 0 : (user.invoiceCount || 0)

    res.json({
      success: true,
      businesses: user.businesses || [],
      invoices: outInvoices,
      quotations: ledger.quotations.map(strip),
      creditNotes: ledger.creditNotes.map(strip),
      customers: outCustomers,
      payments,
      items,
      stats: {
        ...ledger.totals,
        invoiceCount: outInvoices.length,
        draftCount: outInvoices.filter(inv => inv.status === 'draft').length,
        quotationCount: ledger.quotations.length,
        creditNoteCount: ledger.creditNotes.length,
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
