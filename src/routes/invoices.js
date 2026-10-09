const express = require('express')
const auth = require('../middleware/auth')
const User = require('../models/User')
const Invoice = require('../models/Invoice')
const Payment = require('../models/Payment')
const Customer = require('../models/Customer')
const { calcInvoice, r2 } = require('../utils/invoiceCalc')

const router = express.Router()

const FREE_LIMIT = 3
const STATUSES = ['draft', 'sent', 'paid', 'cancelled']

// Client se sirf yehi fields accept honge — userId / customerId / grandTotal jaise
// fields request body se kabhi set nahi ho sakte
const INVOICE_FIELDS = [
  'no', 'date', 'dueDate', 'poNumber', 'status', 'template', 'currency',
  'bizId', 'bizName', 'bizEmail', 'bizPhone', 'bizAltPhone', 'bizAltEmail', 'bizGst', 'bizAddr', 'bizLogo',
  'clientName', 'clientEmail', 'clientPhone', 'clientGst', 'clientAddr', 'placeOfSupply',
  'items', 'discPct', 'taxPct', 'shipping', 'roundOff',
  'notes', 'terms', 'bankDetails', 'upiId', 'signatory',
]
const ITEM_FIELDS = ['id', 'type', 'desc', 'hsnSac', 'uqc', 'qty', 'rate', 'gstRate', 'hsn', 'gst']
const MAX_LOGO_CHARS = 150000 // ~110 KB image

const num = (v, fallback = 0) => {
  const n = Number(v)
  return isNaN(n) ? fallback : n
}

function cleanInvoiceBody(body = {}) {
  const out = {}
  for (const k of INVOICE_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k]
  }
  if (out.no !== undefined) out.no = String(out.no).trim()
  if (out.bizId === undefined || out.bizId === '') delete out.bizId
  if (out.status === 'overdue') out.status = 'sent'
  if (out.status !== undefined && !STATUSES.includes(out.status)) delete out.status
  if (out.discPct !== undefined) out.discPct = Math.min(100, Math.max(0, num(out.discPct)))
  if (out.taxPct !== undefined) out.taxPct = num(out.taxPct, 18)
  if (out.shipping !== undefined) out.shipping = Math.max(0, num(out.shipping))
  if (out.roundOff !== undefined) out.roundOff = Boolean(out.roundOff)
  if (typeof out.bizLogo === 'string' && (out.bizLogo.length > MAX_LOGO_CHARS || !out.bizLogo.startsWith('data:image/'))) out.bizLogo = ''
  if (out.items !== undefined) {
    out.items = (Array.isArray(out.items) ? out.items : []).slice(0, 200).map(it => {
      const item = {}
      for (const k of ITEM_FIELDS) {
        if (it && it[k] !== undefined && it[k] !== null && it[k] !== '') item[k] = it[k]
      }
      item.qty = num(item.qty)
      item.rate = num(item.rate)
      if (item.gstRate !== undefined) item.gstRate = num(item.gstRate)
      if (item.gst !== undefined) item.gst = num(item.gst)
      return item
    })
  }
  return out
}

const isProUser = (user) => Boolean(user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date())

// Pro expire ho chuka ho to flag reset kar do (purana behaviour — same rakha hai)
async function refreshProState(user) {
  const isPro = isProUser(user)
  if (!isPro && user.isPro) {
    await User.findByIdAndUpdate(user._id, { isPro: false, invoiceCount: 0 })
    user.invoiceCount = 0
    user.isPro = false
  }
  return isPro
}

// Invoice ke client ko Clients list mein dhundo ya bana do, aur uska _id lautao.
// Match: same GSTIN, warna same naam (case-insensitive).
async function findOrCreateCustomer(userId, inv) {
  const name = String(inv.clientName || '').trim()
  if (!name) return null

  const customers = await Customer.find({ userId }).lean()
  const gst = String(inv.clientGst || '').trim().toUpperCase()
  const lname = name.toLowerCase()
  let match = (gst && customers.find(c => String(c.gst || '').trim().toUpperCase() === gst && String(c.name || '').trim().toLowerCase() === lname))
    || customers.find(c => String(c.name || '').trim().toLowerCase() === lname)

  if (match) {
    // Khaali fields ko invoice ki details se bhar do — pehle se bhari cheez overwrite nahi hoti
    const patch = {}
    if (!match.email && inv.clientEmail) patch.email = inv.clientEmail
    if (!match.phone && inv.clientPhone) patch.phone = inv.clientPhone
    if (!match.gst && inv.clientGst) patch.gst = inv.clientGst
    if (!match.addr && inv.clientAddr) patch.addr = inv.clientAddr
    if (Object.keys(patch).length) await Customer.findByIdAndUpdate(match._id, patch)
    return match._id
  }

  const created = new Customer({
    userId,
    bizId: inv.bizId || null,
    name,
    email: inv.clientEmail || '',
    phone: inv.clientPhone || '',
    gst: inv.clientGst || '',
    addr: inv.clientAddr || '',
  })
  await created.save()
  return created._id
}

// Har invoice ke saath uska total / paid / balance jod do
function decorate(invoice, paidByInvoice) {
  const total = calcInvoice(invoice).total
  const paid = r2(paidByInvoice[String(invoice._id)] || 0)
  return { ...invoice, grandTotal: total, paidAmount: paid, balance: r2(Math.max(0, total - paid)) }
}

async function paidMap(userId, invoiceId) {
  const filter = { userId }
  if (invoiceId) filter.invoiceId = invoiceId
  const payments = await Payment.find(filter).lean()
  const map = {}
  for (const p of payments) {
    const k = String(p.invoiceId)
    map[k] = (map[k] || 0) + (Number(p.amount) || 0)
  }
  return map
}

// ─── GET /api/invoices/status ─────────────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const isPro = await refreshProState(user)

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
// Purane app versions ke liye rakha hai. Naya app seedha POST /api/invoices use karta hai,
// jo limit check + count dono khud karta hai (countUsage: true ke saath).
router.post('/generate', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const isPro = await refreshProState(user)

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

// ─── Businesses ───────────────────────────────────────────────
// NOTE: ye dono routes '/:id' wale routes se PEHLE hone zaroori hain — warna
// PUT /businesses ko Express '/:id' (id = "businesses") samajh leta hai aur save fail ho jata hai.

// GET /api/invoices/businesses — saved businesses fetch karo
router.get('/businesses', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean()
    res.json({ success: true, businesses: user.businesses || [] })
  } catch (err) {
    console.error('GET /businesses error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PUT /api/invoices/businesses — businesses save karo
router.put('/businesses', auth, async (req, res) => {
  try {
    if (!Array.isArray(req.body.businesses)) {
      return res.status(400).json({ error: 'businesses array bhejna zaroori hai' })
    }
    const BIZ_FIELDS = ['id', 'name', 'email', 'phone', 'altPhone', 'altEmail', 'gst', 'addr', 'prefix',
      'logo', 'bankDetails', 'upiId', 'terms', 'signatory']
    const businesses = req.body.businesses.slice(0, 50)
      .filter(b => b && typeof b === 'object' && b.id && String(b.name || '').trim())
      .map(b => {
        const out = {}
        for (const k of BIZ_FIELDS) if (b[k] !== undefined && b[k] !== null) out[k] = String(b[k])
        if (out.logo && (out.logo.length > MAX_LOGO_CHARS || !out.logo.startsWith('data:image/'))) out.logo = ''
        return out
      })
    await User.findByIdAndUpdate(req.user._id, { businesses })
    res.json({ success: true, businesses })
  } catch (err) {
    console.error('PUT /businesses error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── GET /api/invoices ────────────────────────────────────────
// Sabhi invoices fetch karo (us user ki) — har ek ke saath grandTotal / paidAmount / balance
router.get('/', auth, async (req, res) => {
  try {
    const [invoices, paid] = await Promise.all([
      Invoice.find({ userId: req.user._id }).sort({ createdAt: -1 }).lean(),
      paidMap(req.user._id),
    ])
    res.json({ success: true, invoices: invoices.map(inv => decorate(inv, paid)) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /api/invoices ───────────────────────────────────────
// Naya invoice save karo.
//  - Same business mein same number pehle se ho to 409 (pehle chupchaap overwrite ho jata tha)
//  - body.countUsage === true ho to free-plan limit yahin check + count hoti hai
router.post('/', auth, async (req, res) => {
  try {
    const data = cleanInvoiceBody(req.body)
    if (!data.no) return res.status(400).json({ error: 'Invoice number zaroori hai' })
    if (!String(data.clientName || '').trim()) return res.status(400).json({ error: 'Client ka naam zaroori hai' })

    const existing = await Invoice.findOne({ userId: req.user._id, bizId: data.bizId || null, no: data.no })
    if (existing) {
      return res.status(409).json({
        error: 'duplicate_number',
        message: `Invoice number ${data.no} is business mein pehle se use ho chuka hai. Koi aur number daalein.`
      })
    }

    let invoiceCount
    if (req.body.countUsage === true) {
      const user = await User.findById(req.user._id)
      const isPro = await refreshProState(user)
      if (!isPro && (user.invoiceCount || 0) >= FREE_LIMIT) {
        return res.status(403).json({
          error: 'free_limit_reached',
          message: `Free plan mein sirf ${FREE_LIMIT} invoices generate ho sakte hain. Pro upgrade karo!`,
          invoiceCount: user.invoiceCount,
          freeLimit: FREE_LIMIT
        })
      }
      invoiceCount = (user.invoiceCount || 0) + 1
    }

    const invoice = new Invoice({ ...data, userId: req.user._id })
    invoice.grandTotal = calcInvoice(data).total
    invoice.customerId = await findOrCreateCustomer(req.user._id, data)
    await invoice.save()

    // Count tabhi badhao jab invoice sach mein save ho gaya ho
    if (req.body.countUsage === true) {
      await User.findByIdAndUpdate(req.user._id, { $inc: { invoiceCount: 1 } })
    }

    res.json({ success: true, invoice: decorate(invoice.toObject(), {}), invoiceCount })
  } catch (err) {
    console.error(err)
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'duplicate_number', message: 'Ye invoice number pehle se use ho chuka hai.' })
    }
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── GET /api/invoices/:id ────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.user._id }).lean()
    if (!invoice) return res.status(404).json({ error: 'Invoice nahi mili' })
    const paid = await paidMap(req.user._id, invoice._id)
    res.json({ success: true, invoice: decorate(invoice, paid) })
  } catch (err) {
    res.status(404).json({ error: 'Invoice nahi mili' })
  }
})

// ─── PUT /api/invoices/:id ────────────────────────────────────
// Invoice update karo (status change, edit, etc.)
router.put('/:id', auth, async (req, res) => {
  try {
    const current = await Invoice.findOne({ _id: req.params.id, userId: req.user._id }).lean()
    if (!current) return res.status(404).json({ error: 'Invoice nahi mili' })

    const data = cleanInvoiceBody(req.body)
    if (data.no !== undefined && !data.no) return res.status(400).json({ error: 'Invoice number zaroori hai' })

    // Number ya business badla ho to duplicate check
    const nextNo = data.no !== undefined ? data.no : current.no
    const nextBiz = data.bizId !== undefined ? data.bizId : (current.bizId || null)
    if (nextNo !== current.no || nextBiz !== (current.bizId || null)) {
      const clash = await Invoice.findOne({ userId: req.user._id, bizId: nextBiz, no: nextNo })
      if (clash && String(clash._id) !== String(current._id)) {
        return res.status(409).json({
          error: 'duplicate_number',
          message: `Invoice number ${nextNo} is business mein pehle se use ho chuka hai. Koi aur number daalein.`
        })
      }
    }

    const merged = { ...current, ...data }
    const total = calcInvoice(merged).total
    data.grandTotal = total

    // Status ko payments ke saath consistent rakho
    const paid = await paidMap(req.user._id, current._id)
    const paidAmount = r2(paid[String(current._id)] || 0)
    if (merged.status !== 'cancelled' && merged.status !== 'draft') {
      if (paidAmount > 0 && paidAmount >= total - 0.01) data.status = 'paid'
      else if (merged.status === 'paid' && paidAmount < total - 0.01 && data.status === undefined) data.status = 'sent'
    }

    if (data.clientName !== undefined || !current.customerId) {
      data.customerId = await findOrCreateCustomer(req.user._id, merged)
    }

    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      data,
      { new: true }
    ).lean()
    res.json({ success: true, invoice: decorate(invoice, paid) })
  } catch (err) {
    console.error(err)
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'duplicate_number', message: 'Ye invoice number pehle se use ho chuka hai.' })
    }
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── DELETE /api/invoices/:id ─────────────────────────────────
// Invoice delete karo — uske payment records bhi saath mein hat jate hain
router.delete('/:id', auth, async (req, res) => {
  try {
    const invoice = await Invoice.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice nahi mili' })
    await Payment.deleteMany({ userId: req.user._id, invoiceId: invoice._id })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
