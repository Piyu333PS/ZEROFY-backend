const mongoose = require('mongoose')

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },

  amount: { type: Number, required: true },
  date: { type: String, required: true },  // YYYY-MM-DD, invoice ke date field jaisa hi format

  // 'upi' | 'cash' | 'bank_transfer' | 'card' | 'cheque' | 'other'
  method: { type: String, default: 'upi' },

  notes: { type: String, default: '' },

}, { timestamps: true })

module.exports = mongoose.model('Payment', paymentSchema)
