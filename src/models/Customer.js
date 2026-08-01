const mongoose = require('mongoose')

const customerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Naya invoice banate waqt jis business se ye customer juda hai (optional filter ke liye)
  bizId: { type: String, default: null },

  name: { type: String, required: true, trim: true },
  email: { type: String, default: '', lowercase: true, trim: true },
  phone: { type: String, default: '', trim: true },
  gst: { type: String, default: '', trim: true },
  addr: { type: String, default: '' },

  notes: { type: String, default: '' },

}, { timestamps: true })

// Same user ke andar duplicate customer (same name + phone) rokne ke liye — strict unique nahi,
// bas ek helpful index taaki lookup fast rahe
customerSchema.index({ userId: 1, name: 1 })

module.exports = mongoose.model('Customer', customerSchema)
