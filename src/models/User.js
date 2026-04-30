const mongoose = require('mongoose')

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, default: null },
  googleId: { type: String, default: null },
  resumeCount: { type: Number, default: 0 },
  invoiceCount: { type: Number, default: 0 },  // Invoice limit track karne ke liye
  freeLimit: { type: Number, default: 2 },
  isPro: { type: Boolean, default: false },
  proExpiry: { type: Date, default: null },
  razorpayCustomerId: { type: String, default: null },
}, { timestamps: true })

module.exports = mongoose.model('User', userSchema)
