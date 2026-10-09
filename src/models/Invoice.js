const mongoose = require('mongoose')

const invoiceItemSchema = new mongoose.Schema({
  id: { type: String, default: '' },
  type: { type: String, default: 'goods' },      // 'goods' | 'service'
  desc: { type: String, default: '' },
  hsnSac: { type: String, default: '' },
  uqc: { type: String, default: 'PCS' },
  qty: { type: Number, default: 1 },
  rate: { type: Number, default: 0 },
  gstRate: { type: Number },                      // per-item GST % (naye invoices)

  // Purane invoices ke fields — sirf padhne ke liye rakhe hain (backward compatible)
  hsn: { type: String },
  gst: { type: Number },
}, { _id: false })

const invoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // 'invoice' | 'quotation' | 'credit_note' — missing on older documents, which are invoices
  docType: { type: String, enum: ['invoice', 'quotation', 'credit_note'], default: 'invoice', index: true },

  // Invoice details
  no: { type: String, required: true, trim: true },
  date: { type: String },
  dueDate: { type: String, default: '' },
  poNumber: { type: String, default: '' },
  // 'overdue' kabhi store nahi hota (due date se nikalta hai) — enum mein sirf purane clients ke liye hai
  status: { type: String, enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled', 'accepted', 'declined', 'converted', 'issued'], default: 'draft' },
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
  bizLogo: { type: String, default: '' },         // chhota data-URL (frontend compress karke bhejta hai)

  // Client info
  // customerId set hoga agar ye invoice ek saved Customer se linked hai.
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
  clientName: { type: String, default: '' },
  clientEmail: { type: String, default: '' },
  clientPhone: { type: String, default: '' },
  clientGst: { type: String, default: '' },
  clientAddr: { type: String, default: '' },
  placeOfSupply: { type: String, default: '' },   // 2-digit GST state code

  // Items & totals
  items: [invoiceItemSchema],
  discPct: { type: Number, default: 0 },
  taxPct: { type: Number, default: 18 },
  shipping: { type: Number, default: 0 },
  roundOff: { type: Boolean, default: false },
  grandTotal: { type: Number, default: 0 },       // server-side calculated, har save par update hota hai

  // Quotation only
  validTill: { type: String, default: '' },
  convertedInvoiceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  convertedInvoiceNo: { type: String, default: '' },
  // Invoice made from a quotation
  fromQuotationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  fromQuotationNo: { type: String, default: '' },
  // Credit note only — the invoice it reduces
  refInvoiceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  refInvoiceNo: { type: String, default: '' },
  refInvoiceDate: { type: String, default: '' },
  reason: { type: String, default: '' },

  notes: { type: String, default: '' },
  terms: { type: String, default: '' },
  bankDetails: { type: String, default: '' },
  upiId: { type: String, default: '' },
  signatory: { type: String, default: '' },

}, { timestamps: true })

// Invoice number unique hona chahiye — lekin per-business, taaki alag businesses
// same number (jaise INV-2026-001) alag-alag use kar sakein bina ek dusre ko overwrite kiye
invoiceSchema.index({ userId: 1, bizId: 1, no: 1 }, { unique: true })

module.exports = mongoose.model('Invoice', invoiceSchema)
