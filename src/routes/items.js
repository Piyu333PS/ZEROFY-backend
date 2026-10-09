const express = require('express')
const auth = require('../middleware/authLite')
const Item = require('../models/Item')
const { cleanItem } = require('../utils/catalog')

const router = express.Router()

// ─── GET /api/items ────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const items = await Item.find({ userId: req.user._id }).sort({ name: 1 }).lean()
    res.json({ success: true, items })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /api/items ───────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const data = cleanItem(req.body)
    if (!data.name) return res.status(400).json({ error: 'Item ka naam zaroori hai' })

    const all = await Item.find({ userId: req.user._id }).lean()
    if (all.some(i => String(i.name).trim().toLowerCase() === data.name.toLowerCase())) {
      return res.status(409).json({ error: 'Is naam ka item pehle se saved hai' })
    }
    const item = new Item({ ...data, userId: req.user._id })
    await item.save()
    res.json({ success: true, item })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── PUT /api/items/:id ────────────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  try {
    const data = cleanItem(req.body)
    if (data.name !== undefined && !data.name) return res.status(400).json({ error: 'Item ka naam zaroori hai' })
    const item = await Item.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, data, { new: true })
    if (!item) return res.status(404).json({ error: 'Item nahi mila' })
    res.json({ success: true, item })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── DELETE /api/items/:id ─────────────────────────────────────
// Sirf saved list se hatta hai — purane invoices par koi asar nahi
router.delete('/:id', auth, async (req, res) => {
  try {
    const item = await Item.findOneAndDelete({ _id: req.params.id, userId: req.user._id })
    if (!item) return res.status(404).json({ error: 'Item nahi mila' })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
