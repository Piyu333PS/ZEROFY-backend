const express = require('express')
const auth = require('../middleware/auth')
const User = require('../models/User')
const Invoice = require('../models/Invoice')
const Purchase = require('../models/Purchase')
const SalesPerson = require('../models/SalesPerson')
const { cleanCode, summarise, isAdminEmail } = require('../utils/sales')

// The owner's panel. Only the emails listed in ADMIN_EMAILS (Vercel setting, comma separated) may use it.
const router = express.Router()
const adminOnly = (req, res, next) => (isAdminEmail(req.user.email) ? next() : res.status(403).json({ error: 'Not allowed' }))
router.use(auth)
router.use(adminOnly)

const DAY = 24 * 3600 * 1000
const isProNow = (u) => Boolean(u.isPro && u.proExpiry && new Date(u.proExpiry) > new Date())
const userRow = (u, invoiceTotals = {}) => {
  const biz = (u.businesses || [])[0] || {}
  return {
    _id: u._id, email: u.email, google: Boolean(u.googleId),
    business: biz.name || (u.billing && u.billing.firm) || '', phone: biz.phone || (u.billing && u.billing.phone) || '', gstin: biz.gst || '',
    isPro: isProNow(u), proExpiry: u.proExpiry || null, planId: u.lastPlanId || '', autoRenew: u.subscriptionStatus === 'active',
    freeUsed: u.invoiceCount || 0, invoices: invoiceTotals[String(u._id)] || 0, createdAt: u.createdAt,
  }
}

// GET /api/admin/overview — the numbers at a glance
router.get('/overview', async (req, res) => {
  try {
    const [users, purchases] = await Promise.all([User.find({}).lean(), Purchase.find({ status: 'paid' }).lean()])
    const now = Date.now()
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    const pro = users.filter(isProNow)
    const sum = (list) => list.reduce((s, p) => s + (Number(p.total) || 0), 0)
    const recent = [...purchases].sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt)).slice(0, 10)
    const emailOf = Object.fromEntries(users.map(u => [String(u._id), u.email]))
    res.json({
      success: true,
      users: {
        total: users.length,
        new7: users.filter(u => now - new Date(u.createdAt) < 7 * DAY).length,
        new30: users.filter(u => now - new Date(u.createdAt) < 30 * DAY).length,
        setupDone: users.filter(u => (u.businesses || []).length > 0).length,
      },
      pro: {
        active: pro.length,
        autoRenew: pro.filter(u => u.subscriptionStatus === 'active').length,
        expiring7: pro.filter(u => u.subscriptionStatus !== 'active' && new Date(u.proExpiry) - now < 7 * DAY).length,
      },
      revenue: {
        allTime: sum(purchases), thisMonth: sum(purchases.filter(p => new Date(p.paidAt) >= monthStart)),
        payments: purchases.length, withSalesCode: purchases.filter(p => p.salesCode).length,
      },
      recent: recent.map(p => ({ _id: p._id, email: emailOf[String(p.userId)] || '', firm: (p.billing && (p.billing.firm || p.billing.name)) || '', planName: p.planName, total: p.total, paidAt: p.paidAt, salesCode: p.salesCode || '', renewal: Boolean(p.renewal), receiptNo: p.receiptNo })),
    })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/admin/users?q=&filter=all|pro|free|expiring
router.get('/users', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase()
    const filter = String(req.query.filter || 'all')
    const now = Date.now()
    let users = await User.find({}).sort({ createdAt: -1 }).lean()
    if (filter === 'pro') users = users.filter(isProNow)
    else if (filter === 'free') users = users.filter(u => !isProNow(u))
    else if (filter === 'expiring') users = users.filter(u => isProNow(u) && u.subscriptionStatus !== 'active' && new Date(u.proExpiry) - now < 7 * DAY)
    let rows = users.map(u => userRow(u))
    if (q) rows = rows.filter(r => [r.email, r.business, r.phone, r.gstin].some(v => String(v || '').toLowerCase().includes(q)))
    const total = rows.length
    rows = rows.slice(0, 200)
    // how many invoices each listed user has made — shows who is really using the app
    const counts = {}
    for (const r of rows) counts[String(r._id)] = await Invoice.countDocuments({ userId: r._id })
    res.json({ success: true, total, users: rows.map(r => ({ ...r, invoices: counts[String(r._id)] || 0 })) })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/admin/users/:id/extend { days } — give or extend Pro by hand (support, offline payment, goodwill)
router.post('/users/:id/extend', async (req, res) => {
  try {
    const days = Math.round(Number(req.body.days))
    if (!(days >= 1 && days <= 3660)) return res.status(400).json({ error: 'Enter a number of days between 1 and 3660' })
    let user
    try { user = await User.findById(req.params.id) } catch { user = null }
    if (!user) return res.status(404).json({ error: 'User not found' })
    const from = isProNow(user) ? new Date(user.proExpiry) : new Date()
    from.setDate(from.getDate() + days)
    await User.findByIdAndUpdate(user._id, { isPro: true, proExpiry: from, freeLimit: 999999, expiryReminders: [] })
    console.log(`Admin ${req.user.email} extended Pro for ${user.email} by ${days} days → ${from.toISOString()}`)
    res.json({ success: true, proExpiry: from })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// ─── Sales team ───────────────────────────────────────────────
const cleanPerson = (b = {}) => {
  const out = {}
  if (b.name !== undefined) out.name = String(b.name).trim().slice(0, 80)
  if (b.phone !== undefined) out.phone = String(b.phone).replace(/\D/g, '').slice(-10)
  if (b.email !== undefined) out.email = String(b.email).trim().toLowerCase().slice(0, 120)
  if (b.notes !== undefined) out.notes = String(b.notes).slice(0, 300)
  if (b.active !== undefined) out.active = Boolean(b.active)
  for (const k of ['commissionPct', 'renewalPct']) {
    if (b[k] !== undefined) { const n = Number(b[k]); if (!(n >= 0 && n <= 90)) return { error: 'Commission must be between 0 and 90 percent' }; out[k] = n }
  }
  return { data: out }
}

// GET /api/admin/salespeople — everyone, with what they sold and what they are owed
router.get('/salespeople', async (req, res) => {
  try {
    const [people, purchases, users] = await Promise.all([SalesPerson.find({}).sort({ createdAt: 1 }).lean(), Purchase.find({ status: 'paid' }).lean(), User.find({}).lean()])
    const emailOf = Object.fromEntries(users.map(u => [String(u._id), u.email]))
    const known = new Set(people.map(p => p.code))
    const list = people.map(person => {
      const s = summarise(person, purchases)
      return {
        ...person, hasAccount: Boolean(person.email && users.some(u => u.email === person.email)), totals: s.totals,
        sales: s.rows.map(r => ({ _id: r._id, receiptNo: r.receiptNo, paidAt: r.paidAt, customer: (r.billing && (r.billing.firm || r.billing.name)) || emailOf[String(r.userId)] || '', email: emailOf[String(r.userId)] || '', planName: r.planName, renewal: Boolean(r.renewal), taxable: r.taxable, commission: r.commission, commissionPaidAt: r.commissionPaidAt || null })),
      }
    })
    // Codes typed at checkout that belong to nobody yet — so a sale is never lost to a typo
    const stray = {}
    for (const p of purchases) { const c = cleanCode(p.salesCode); if (c && !known.has(c)) stray[c] = (stray[c] || 0) + 1 }
    res.json({ success: true, salespeople: list, unknownCodes: Object.entries(stray).map(([code, sales]) => ({ code, sales })) })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.post('/salespeople', async (req, res) => {
  try {
    const code = cleanCode(req.body.code)
    if (code.length < 3) return res.status(400).json({ error: 'The code needs at least 3 letters or numbers' })
    const { data, error } = cleanPerson(req.body)
    if (error) return res.status(400).json({ error })
    if (!data.name) return res.status(400).json({ error: 'Enter the name' })
    if (await SalesPerson.findOne({ code })) return res.status(409).json({ error: `The code ${code} is already used` })
    const person = await new SalesPerson({ ...data, code }).save()
    res.json({ success: true, salesperson: person })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.put('/salespeople/:id', async (req, res) => {
  try {
    const { data, error } = cleanPerson(req.body)
    if (error) return res.status(400).json({ error })
    if (data.name !== undefined && !data.name) return res.status(400).json({ error: 'Enter the name' })
    let person
    try { person = await SalesPerson.findByIdAndUpdate(req.params.id, data, { new: true }).lean() } catch { person = null }
    if (!person) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true, salesperson: person })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/admin/commission/paid { purchaseIds: [...], paid: true|false } — tick off commission you have paid out
router.post('/commission/paid', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.purchaseIds) ? req.body.purchaseIds.slice(0, 500) : []
    const paid = req.body.paid !== false
    let n = 0
    for (const id of ids) {
      try { if (await Purchase.findByIdAndUpdate(id, { commissionPaidAt: paid ? new Date() : null })) n++ } catch { /* bad id */ }
    }
    res.json({ success: true, updated: n })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
