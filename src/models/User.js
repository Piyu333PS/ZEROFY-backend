const mongoose = require('mongoose')

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, default: null },
  googleId: { type: String, default: null },
  resumeCount: { type: Number, default: 0 },
  invoiceCount: { type: Number, default: 0 },
  freeLimit: { type: Number, default: 2 },
  isPro: { type: Boolean, default: false },
  proExpiry: { type: Date, default: null },
  razorpayCustomerId: { type: String, default: null },
  lastPlanId: { type: String, default: null },           // 🆕 monthly | quarterly | yearly
  lastPaymentId: { type: String, default: null },        // 🆕 last Razorpay payment ID
  subscriptionId: { type: String, default: null },       // 🆕 Razorpay subscription ID
  subscriptionStatus: { type: String, default: null },   // 🆕 created | active | halted | cancelled
  businesses: { type: Array, default: [] },              // saved business profiles

  // Forgot password — 6-digit code ka hash (code khud kabhi store nahi hota)
  resetCodeHash: { type: String, default: null },
  resetCodeExpiry: { type: Date, default: null },
  resetCodeSentAt: { type: Date, default: null },
  resetCodeAttempts: { type: Number, default: 0 },
}, { timestamps: true })

module.exports = mongoose.model('User', userSchema)
