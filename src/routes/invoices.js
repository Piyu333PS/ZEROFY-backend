const express = require('express')
const auth = require('../middleware/authLite')
const User = require('../models/User')
const Invoice = require('../models/Invoice')
const Payment = require('../models/Payment')
const Customer = require('../models/Customer')
const { calcInvoice, r2 } = require('../utils/invoiceCalc')
const { rememberItems } = require('../utils/catalog')
const { docTypeOf, paidMapOf, creditMapOf, decorateInvoice, decorateOther, settledStatus } = require('../utils/ledger')
const { syncInvoiceStatus } = require('./payments')

const router = express.Router()

const FREE_LIMIT = 3
// Which statuses the app may set, per document type. A quotation becomes 'converted' only on the server.
const STATUSES = {
  invoice: ['draft', 'sent', 'paid', 'cancelled'],
  quotation: ['draft', 'sent', 'accepted', 'declined'],
  credit_note: ['issued', 'cancelled'],
}
const DEFAULT_STATUS = { invoice: 'draft', quotation: 'sent', credit_note: 'issued' }
const LABEL = { invoice: 'Invoice', quotation: 'Quotation', credit_note: 'Credit note' }

// Client se sirf yehi fields accept honge — userId / customerId / grandTotal jaise
// fields request body se kabhi set nahi ho sakte
const INVOICE_FIELDS = [
  'no', 'date', 'dueDate', 'poNumber', 'status', 'template', 'currency',
  'bizId', 'bizName', 'bizEmail', 'bizPhone', 'bizAltPhone', 'bizAltEmail', 'bizGst', 'bizAddr', 'bizLogo',
  'clientName', 'clientEmail', 'clientPhone', 'clientGst', 'clientAddr', 'placeOfSupply',
  'items', 'discPct', 'taxPct', 'shipping', 'roundOff',
  'notes', 'terms', 'bankDetails', 'upiId', 'signatory',
  'validTill', 'reason',
]
const ITEM_FIELDS = ['id', 'type', 'desc', 'hsnSac', 'uqc', 'qty', 'rate', 'gstRate', 'hsn', 'gst']
const MAX_LOGO_CHARS = 150000 // ~110 KB image

const num = (v, fallback = 0) => {
  const n = Number(v)
  return isNaN(n) ? fallback : n
}

function cleanInvoiceBody(body = {}, docType = 'invoice') {
  const out = {}
  for (const k of INVOICE_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k]
  }
  if (out.no !== undefined) out.no = String(out.no).trim()
  if (out.bizId === undefined || out.bizId === '') delete out.bizId
  if (out.status === 'overdue') out.status = 'sent'
  if (out.status !== undefined && !STATUSES[docType].includes(out.status)) delete out.status
  if (out.validTill !== undefined) out.validTill = String(out.validTill || '').slice(0, 10)
  if (out.reason !== undefined) out.reason = String(out.reason || '').slice(0, 300)
  if (docType !== 'quotation') delete out.validTill
  if (docType !== 'credit_note') delete out.reason
  if (out.discPct !== undefined) out.discPct = Math.min(100, Math.max(0, num(out.discPct)))
  if (out.taxPct !== undefined) out.taxPct = num(out.taxPct, 18)
  if (out.shipping !== undefined) out.shipping = Math.max(0, num(out.shipping))
  if (out.roundOff !== undefined) out.roundOff = Boolean(out.roundOff)
  // Logo har invoice ke saath store nahi hota (list bhaari ho jati thi) — wo business profile se aata hai
  if (out.bizLogo !== undefined) out.bizLogo = ''
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

// Add total / paid / credited / balance to one document
async function decorateOne(userId, doc) {
  if (docTypeOf(doc) !== 'invoice') return decorateOther(doc)
  const [payments, notes] = await Promise.all([
    Payment.find({ userId, invoiceId: doc._id }).lean(),
    Invoice.find({ userId, refInvoiceId: doc._id }).lean(),
  ])
  return decorateInvoice(doc, paidMapOf(payments), creditMapOf(notes))
}

const sameId = (a, b) => String(a || '') === String(b || '')

async function findOwned(userId, id) {
  if (!id) return null
  try { return await Invoice.findOne({ _id: id, userId }).lean() } catch { return null }
}

// A credit note must point at a real, issued invoice and cannot be worth more than
// what is still left on that invoice after earlier credit notes.
async function checkCreditNote(userId, data, refInvoiceId, selfId) {
  const ref = await findOwned(userId, refInvoiceId)
  if (!ref || docTypeOf(ref) !== 'invoice') return { error: 'Choose the invoice this credit note is for' }
  if (ref.status === 'draft') return { error: 'A credit note cannot be made for a draft invoice. Edit the draft instead.' }
  if (ref.status === 'cancelled') return { error: 'A credit note cannot be made for a cancelled invoice' }
  const total = calcInvoice(data).total
  if (!(total > 0)) return { error: 'The credit note amount must be more than 0' }
  const notes = await Invoice.find({ userId, refInvoiceId: ref._id }).lean()
  const others = creditMapOf(notes.filter(n => !sameId(n._id, selfId)))[String(ref._id)] || 0
  const room = r2(calcInvoice(ref).total - others)
  if (total > room + 0.01) {
    return { error: room > 0
      ? `This is more than the invoice. Up to ${room.toFixed(2)} can still be credited on ${ref.no}.`
      : `Invoice ${ref.no} has already been credited in full.` }
  }
  return { ref }
}

async function syncRefInvoice(userId, refInvoiceId) {
  if (!refInvoiceId) return
  try {
    const ref = await Invoice.findOne({ _id: refInvoiceId, userId })
    if (ref) await syncInvoiceStatus(ref)
  } catch (e) { console.error('Credit note sync error:', e) }
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
        message: `The free plan includes ${FREE_LIMIT} invoices. Upgrade to Pro for unlimited invoices.`,
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
      return res.status(400).json({ error: 'A businesses list is required' })
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

// ─── GET /api/invoices?docType=invoice|quotation|credit_note ──
// Documents of one type (invoices when not given). Invoices come with grandTotal / paidAmount / creditedAmount / balance.
router.get('/', auth, async (req, res) => {
  try {
    const want = STATUSES[req.query.docType] ? req.query.docType : 'invoice'
    const [docs, payments] = await Promise.all([
      Invoice.find({ userId: req.user._id }).sort({ createdAt: -1 }).lean(),
      Payment.find({ userId: req.user._id }).lean(),
    ])
    const paid = paidMapOf(payments), credit = creditMapOf(docs)
    const list = docs.filter(d => docTypeOf(d) === want)
      .map(d => want === 'invoice' ? decorateInvoice(d, paid, credit) : decorateOther(d))
    res.json({ success: true, invoices: list })
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
    const docType = STATUSES[req.body.docType] ? req.body.docType : 'invoice'
    const label = LABEL[docType]
    const data = cleanInvoiceBody(req.body, docType)
    data.docType = docType
    if (!data.status) data.status = DEFAULT_STATUS[docType]
    if (!data.no) return res.status(400).json({ error: `${label} number is required` })
    if (!String(data.clientName || '').trim()) return res.status(400).json({ error: 'Client name is required' })

    const existing = await Invoice.findOne({ userId: req.user._id, bizId: data.bizId || null, no: data.no })
    if (existing) {
      return res.status(409).json({
        error: 'duplicate_number',
        message: `Number ${data.no} is already used for this business. Enter a different number.`
      })
    }

    let refInvoice = null
    if (docType === 'credit_note') {
      const check = await checkCreditNote(req.user._id, data, req.body.refInvoiceId, null)
      if (check.error) return res.status(400).json({ error: check.error })
      refInvoice = check.ref
      data.refInvoiceId = refInvoice._id
      data.refInvoiceNo = refInvoice.no
      data.refInvoiceDate = refInvoice.date || ''
    }

    let quotation = null
    if (docType === 'invoice' && req.body.fromQuotationId) {
      quotation = await findOwned(req.user._id, req.body.fromQuotationId)
      if (quotation && docTypeOf(quotation) === 'quotation') {
        data.fromQuotationId = quotation._id
        data.fromQuotationNo = quotation.no
      } else quotation = null
    }

    // Only invoices count towards the free plan — quotations and credit notes are free
    const countUsage = docType === 'invoice' && req.body.countUsage === true
    let invoiceCount
    if (countUsage) {
      const user = await User.findById(req.user._id)
      const isPro = await refreshProState(user)
      if (!isPro && (user.invoiceCount || 0) >= FREE_LIMIT) {
        return res.status(403).json({
          error: 'free_limit_reached',
          message: `The free plan includes ${FREE_LIMIT} invoices. Upgrade to Pro for unlimited invoices.`,
          invoiceCount: user.invoiceCount,
          freeLimit: FREE_LIMIT
        })
      }
      invoiceCount = (user.invoiceCount || 0) + 1
    }

    const invoice = new Invoice({ ...data, userId: req.user._id })
    invoice.grandTotal = calcInvoice(data).total
    if (refInvoice && refInvoice.customerId) {
      invoice.customerId = refInvoice.customerId
    } else {
      const [customerId] = await Promise.all([
        findOrCreateCustomer(req.user._id, data),
        docType === 'credit_note' ? null : rememberItems(req.user._id, data.items),
      ])
      invoice.customerId = customerId
    }
    await invoice.save()

    // Count only after the invoice is really saved
    if (countUsage) {
      await User.findByIdAndUpdate(req.user._id, { $inc: { invoiceCount: 1 } })
    }
    if (quotation) {
      await Invoice.findByIdAndUpdate(quotation._id, {
        status: 'converted', convertedInvoiceId: invoice._id, convertedInvoiceNo: invoice.no,
      })
    }
    if (refInvoice) await syncRefInvoice(req.user._id, refInvoice._id)

    res.json({ success: true, invoice: await decorateOne(req.user._id, invoice.toObject()), invoiceCount })
  } catch (err) {
    console.error(err)
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'duplicate_number', message: 'This number is already used.' })
    }
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── GET /api/invoices/:id ────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.user._id }).lean()
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    res.json({ success: true, invoice: await decorateOne(req.user._id, invoice) })
  } catch (err) {
    res.status(404).json({ error: 'Invoice not found' })
  }
})

// ─── PUT /api/invoices/:id ────────────────────────────────────
// Invoice update karo (status change, edit, etc.)
router.put('/:id', auth, async (req, res) => {
  try {
    const current = await findOwned(req.user._id, req.params.id)
    if (!current) return res.status(404).json({ error: 'Invoice not found' })
    const docType = docTypeOf(current) // the type of a document never changes
    const label = LABEL[docType]

    const data = cleanInvoiceBody(req.body, docType)
    if (data.no !== undefined && !data.no) return res.status(400).json({ error: `${label} number is required` })
    // A converted quotation stays converted while its invoice exists
    if (docType === 'quotation' && current.status === 'converted') delete data.status

    // Duplicate check when the number or business changes
    const nextNo = data.no !== undefined ? data.no : current.no
    const nextBiz = data.bizId !== undefined ? data.bizId : (current.bizId || null)
    if (nextNo !== current.no || nextBiz !== (current.bizId || null)) {
      const clash = await Invoice.findOne({ userId: req.user._id, bizId: nextBiz, no: nextNo })
      if (clash && String(clash._id) !== String(current._id)) {
        return res.status(409).json({
          error: 'duplicate_number',
          message: `Number ${nextNo} is already used for this business. Enter a different number.`
        })
      }
    }

    const merged = { ...current, ...data }
    const total = calcInvoice(merged).total
    data.grandTotal = total

    if (docType === 'credit_note' && merged.status !== 'cancelled') {
      const check = await checkCreditNote(req.user._id, merged, current.refInvoiceId, current._id)
      if (check.error) return res.status(400).json({ error: check.error })
    }

    if (docType === 'invoice') {
      // Keep the status in step with payments and credit notes
      const [payments, notes] = await Promise.all([
        Payment.find({ userId: req.user._id, invoiceId: current._id }).lean(),
        Invoice.find({ userId: req.user._id, refInvoiceId: current._id }).lean(),
      ])
      const paidAmount = paidMapOf(payments)[String(current._id)] || 0
      const credited = creditMapOf(notes)[String(current._id)] || 0
      if (merged.status !== 'cancelled' && merged.status !== 'draft') {
        const settled = settledStatus(merged, paidAmount, credited)
        if (settled === 'paid') data.status = 'paid'
        else if (merged.status === 'paid' && data.status === undefined) data.status = 'sent'
      }
      if ((merged.status === 'draft' || merged.status === 'cancelled') && credited > 0 && current.status !== merged.status) {
        return res.status(400).json({ error: 'This invoice has a credit note. Cancel or delete the credit note first.' })
      }
    }

    if (docType !== 'credit_note' && (data.clientName !== undefined || !current.customerId)) {
      data.customerId = await findOrCreateCustomer(req.user._id, merged)
    }

    if (data.items !== undefined && docType !== 'credit_note') await rememberItems(req.user._id, data.items)

    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      data,
      { new: true }
    ).lean()
    if (docType === 'credit_note') await syncRefInvoice(req.user._id, current.refInvoiceId)
    res.json({ success: true, invoice: await decorateOne(req.user._id, invoice) })
  } catch (err) {
    console.error(err)
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'duplicate_number', message: 'This number is already used.' })
    }
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── DELETE /api/invoices/:id ─────────────────────────────────
// Invoice delete karo — uske payment records bhi saath mein hat jate hain
router.delete('/:id', auth, async (req, res) => {
  try {
    const current = await findOwned(req.user._id, req.params.id)
    if (!current) return res.status(404).json({ error: 'Invoice not found' })
    const docType = docTypeOf(current)

    if (docType === 'invoice') {
      const notes = await Invoice.find({ userId: req.user._id, refInvoiceId: current._id }).lean()
      if (notes.length) {
        return res.status(400).json({ error: 'This invoice has a credit note. Delete the credit note first.' })
      }
    }

    await Invoice.findOneAndDelete({ _id: current._id, userId: req.user._id })

    if (docType === 'invoice') {
      await Payment.deleteMany({ userId: req.user._id, invoiceId: current._id })
      // The quotation this invoice came from can be converted again
      if (current.fromQuotationId) {
        const q = await findOwned(req.user._id, current.fromQuotationId)
        if (q && sameId(q.convertedInvoiceId, current._id)) {
          await Invoice.findByIdAndUpdate(q._id, { status: 'accepted', convertedInvoiceId: null, convertedInvoiceNo: '' })
        }
      }
    }
    if (docType === 'credit_note') await syncRefInvoice(req.user._id, current.refInvoiceId)
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
