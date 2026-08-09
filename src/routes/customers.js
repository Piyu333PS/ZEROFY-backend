const express = require('express')
const multer = require('multer')
const XLSX = require('xlsx')
const auth = require('../middleware/auth')
const Customer = require('../models/Customer')
const Invoice = require('../models/Invoice')

const router = express.Router()

// Excel/CSV file ko memory mein hi rakho (disk pe save nahi karna, Vercel serverless hai)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
})

// Ek row mein se value nikalne ke liye — header ka naam chahe Naam/Name, GST/GSTIN, Addr/Address ho, sab match ho jaye
const pick = (row, keys) => {
  for (const rawKey of Object.keys(row)) {
    if (keys.includes(rawKey.trim().toLowerCase())) {
      const val = row[rawKey]
      return val === undefined || val === null ? '' : String(val).trim()
    }
  }
  return ''
}

// ─── GET /api/customers ────────────────────────────────────────
// Sabhi customers fetch karo (us user ki), optionally bizId se filter
router.get('/', auth, async (req, res) => {
  try {
    const filter = { userId: req.user._id }
    if (req.query.bizId) filter.bizId = req.query.bizId

    const customers = await Customer.find(filter).sort({ name: 1 }).lean()
    res.json({ success: true, customers })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── GET /api/customers/template ────────────────────────────────
// Bulk import ke liye Excel template download karo (sample row ke saath)
router.get('/template', auth, async (req, res) => {
  try {
    const headers = ['Naam', 'Phone', 'Email', 'GSTIN', 'Address']
    const sample = ['Ravi Upadhayay', '9828552452', 'ravi23@gmail.com', '08EGXPS9616D1ZK', 'Jaipur, Rajasthan']

    const ws = XLSX.utils.aoa_to_sheet([headers, sample])
    ws['!cols'] = [{ wch: 24 }, { wch: 15 }, { wch: 26 }, { wch: 18 }, { wch: 32 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Customers')
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="zerofy-customers-template.xlsx"')
    res.send(buffer)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Template banane mein error aaya' })
  }
})

// ─── POST /api/customers/import ─────────────────────────────────
// Uploaded Excel/CSV se ek saath bahut saare customers create karo
router.post('/import', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File nahi mili' })

    let rows
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
    } catch {
      return res.status(400).json({ error: 'File padhi nahi ja saki. Sahi .xlsx ya .csv file upload karein' })
    }

    if (!rows.length) return res.status(400).json({ error: 'File mein koi data nahi mila' })
    if (rows.length > 2000) return res.status(400).json({ error: 'Ek baar mein max 2000 rows import ho sakti hain' })

    const nameKeys = ['naam', 'name', 'customer name']
    const phoneKeys = ['phone', 'mobile', 'contact', 'phone number']
    const emailKeys = ['email', 'email id']
    const gstKeys = ['gstin', 'gst', 'gst number']
    const addrKeys = ['address', 'addr']

    const toInsert = []
    const errors = []

    rows.forEach((row, i) => {
      const name = pick(row, nameKeys)
      if (!name) {
        errors.push({ row: i + 2, reason: 'Naam missing hai' }) // +2 = header row + 1-index
        return
      }
      toInsert.push({
        userId: req.user._id,
        bizId: req.body.bizId || null,
        name,
        phone: pick(row, phoneKeys),
        email: pick(row, emailKeys),
        gst: pick(row, gstKeys),
        addr: pick(row, addrKeys)
      })
    })

    let createdCount = 0
    if (toInsert.length) {
      const created = await Customer.insertMany(toInsert, { ordered: false })
      createdCount = created.length
    }

    res.json({
      success: true,
      createdCount,
      skippedCount: errors.length,
      totalRows: rows.length,
      errors: errors.slice(0, 20) // pehli 20 hi dikha do, taaki response chota rahe
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Import karte waqt error aaya' })
  }
})

// ─── GET /api/customers/:id ────────────────────────────────────
// Ek customer + uske invoices ki history
router.get('/:id', auth, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, userId: req.user._id }).lean()
    if (!customer) return res.status(404).json({ error: 'Customer nahi mila' })

    const invoices = await Invoice.find({ userId: req.user._id, customerId: customer._id })
      .sort({ createdAt: -1 })
      .lean()

    res.json({ success: true, customer, invoices })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /api/customers ───────────────────────────────────────
// Naya customer banao
router.post('/', auth, async (req, res) => {
  try {
    const { name, email, phone, gst, addr, notes, bizId } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'Customer ka naam zaroori hai' })

    const customer = new Customer({
      userId: req.user._id,
      name: name.trim(),
      email, phone, gst, addr, notes, bizId
    })
    await customer.save()
    res.json({ success: true, customer })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── PUT /api/customers/:id ────────────────────────────────────
// Customer update karo
router.put('/:id', auth, async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true }
    )
    if (!customer) return res.status(404).json({ error: 'Customer nahi mila' })
    res.json({ success: true, customer })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── DELETE /api/customers/:id ─────────────────────────────────
// Customer delete karo (uske invoices delete nahi honge, bas unlink ho jayenge)
router.delete('/:id', auth, async (req, res) => {
  try {
    const customer = await Customer.findOneAndDelete({ _id: req.params.id, userId: req.user._id })
    if (!customer) return res.status(404).json({ error: 'Customer nahi mila' })

    await Invoice.updateMany(
      { userId: req.user._id, customerId: customer._id },
      { $set: { customerId: null } }
    )

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
