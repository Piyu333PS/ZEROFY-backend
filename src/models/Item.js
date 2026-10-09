const mongoose = require('mongoose')

// Saved item / product — invoice banate waqt naam chunte hi rate, HSN, GST apne aap bhar jata hai
const itemSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, default: 'goods' },   // 'goods' | 'service'
  hsnSac: { type: String, default: '', trim: true },
  uqc: { type: String, default: 'PCS' },
  rate: { type: Number, default: 0 },
  gstRate: { type: Number, default: 18 },
}, { timestamps: true })

itemSchema.index({ userId: 1, name: 1 })

module.exports = mongoose.model('Item', itemSchema)
