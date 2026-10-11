const mongoose = require('mongoose')

// A person who sells Zerofy Pro. Customers enter the person's code at checkout (or arrive through
// the person's link) and every such payment is counted towards their commission.
const salesPersonSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, default: '' },
  // If this matches the email of a Zerofy account, that account sees its own "My sales" page
  email: { type: String, default: '', lowercase: true, trim: true, index: true },
  commissionPct: { type: Number, default: 30 },   // on a customer's first payment
  renewalPct: { type: Number, default: 10 },      // on later payments by the same customer
  active: { type: Boolean, default: true },
  notes: { type: String, default: '' },
}, { timestamps: true })

module.exports = mongoose.model('SalesPerson', salesPersonSchema)
