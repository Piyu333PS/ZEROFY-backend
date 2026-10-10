const mongoose = require('mongoose')

// One row per Pro payment (first payment and every Auto Pay renewal).
// It keeps a snapshot of the buyer's billing details and of the price break-up,
// so the tax invoice for a payment never changes later. All amounts are in paise.
const purchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  planId: { type: String, required: true },
  planName: { type: String, default: '' },
  days: { type: Number, default: 0 },
  mode: { type: String, enum: ['once', 'auto'], default: 'once' },
  status: { type: String, enum: ['created', 'paid'], default: 'created', index: true },
  renewal: { type: Boolean, default: false },

  base: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  taxable: { type: Number, default: 0 },
  gstRate: { type: Number, default: 0 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, default: 0 },

  couponCode: { type: String, default: '' },
  salesCode: { type: String, default: '', index: true },   // who sold it — used to work out commission

  billing: { type: Object, default: {} },   // name, firm, phone, email, address, state, pincode, gstin
  seller: { type: Object, default: {} },    // name, address, gstin, state, sac — as they were on the day

  orderId: { type: String, default: '', index: true },
  subscriptionId: { type: String, default: '', index: true },
  paymentId: { type: String, default: '', index: true },
  receiptNo: { type: String, default: '' },
  paidAt: { type: Date, default: null },
}, { timestamps: true })

module.exports = mongoose.model('Purchase', purchaseSchema)
