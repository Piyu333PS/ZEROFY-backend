const mongoose = require('mongoose')

const invoiceItemSchema = new mongoose.Schema({
  desc: { type: String, default: '' },
  qty: { type: Number, default: 1 },
  rate: { type: Number, default: 0 },
  hsn: { type: String, default: '' },
  gst: { type: Number, default: 18 },
}, { _id: false })

const invoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Invoice details
  no: { type: String, required: true },
  date: { type: String },
  status: { type: String, enum: ['draft', 'sent', 'paid', 'cancelled'], default: 'draft' },
  template: { type: String, default: 'modern' },
  currency: { type: String, default: '₹' },

  // Business info
  bizId: { type: String, default: null },
  bizName: { type: String, default: '' },
  bizEmail: { type: String, default: '' },
  bizPhone: { type: String, default: '' },
  bizAltPhone: { type: String, default: '' },
  bizAltEmail: { type: String, default: '' },
  bizGst: { type: String, default: '' },
  bizAddr: { type: String, default: '' },

  // Client info
  clientName: { type: String, default: '' },
  clientEmail: { type: String, default: '' },
  clientPhone: { type: String, default: '' },
  clientGst: { type: String, default: '' },
  clientAddr: { type: String, default: '' },

  // Items & totals
  items: [invoiceItemSchema],
  discPct: { type: Number, default: 0 },
  taxPct: { type: Number, default: 18 },
  notes: { type: String, default: '' },

}, { timestamps: true })

// Ek user ke liye invoice number unique hona chahiye
invoiceSchema.index({ userId: 1, no: 1 }, { unique: true })

module.exports = mongoose.model('Invoice', invoiceSchema)
