const mongoose = require('mongoose')

const userSchema = new mongoose.Schema({
  email:              { type: String, required: true, unique: true, lowercase: true },
  password:           { type: String, required: true },
  resumeCount:        { type: Number, default: 0 },
  freeLimit:          { type: Number, default: 2 },
  isPro:              { type: Boolean, default: false },
  proExpiry:          { type: Date, default: null },
  razorpayCustomerId: { type: String, default: null },
  lastPlanId:         { type: String, default: null },
  lastPaymentId:      { type: String, default: null },
}, { timestamps: true })

module.exports = mongoose.models.User || mongoose.model('User', userSchema)
