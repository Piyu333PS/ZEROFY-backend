const express = require('express')
const auth = require('../middleware/auth')
const Purchase = require('../models/Purchase')
const SalesPerson = require('../models/SalesPerson')
const { summarise } = require('../utils/sales')

const router = express.Router()

// GET /api/sales/me — a salesperson's own page: their code, their sales and their commission.
// Works when the account's email is the email saved on a salesperson. Customer details are kept short:
// the business name, the plan and the date — no phone, address or email.
router.get('/me', auth, async (req, res) => {
  try {
    const person = await SalesPerson.findOne({ email: req.user.email }).lean()
    if (!person || !person.active) return res.status(404).json({ error: 'not_sales' })
    const purchases = await Purchase.find({ status: 'paid', salesCode: person.code }).lean()
    const s = summarise(person, purchases)
    res.json({
      success: true,
      salesperson: { code: person.code, name: person.name, commissionPct: person.commissionPct, renewalPct: person.renewalPct },
      totals: s.totals,
      sales: s.rows.map(r => ({ _id: r._id, paidAt: r.paidAt, customer: (r.billing && (r.billing.firm || r.billing.name)) || 'Customer', planName: r.planName, renewal: Boolean(r.renewal), taxable: r.taxable, commission: r.commission, commissionPaidAt: r.commissionPaidAt || null })),
    })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
