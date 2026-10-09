const jwt = require('jsonwebtoken')
const User = require('../models/User')

// Billing routes ke liye halka auth.
// Normal `auth` har request par User ko database se laata hai (ek poora extra round-trip).
// Billing routes ko sirf user ka _id chahiye, isliye yahan token verify karke
// "ye user exist karta hai" wali baat kuch der ke liye memory mein yaad rakh lete hain.
// Jahan fresh user data chahiye (plan, limits), wo routes khud User.findById karte hain.
const KNOWN_TTL_MS = 5 * 60 * 1000
const known = new Map() // userId -> expiry timestamp

module.exports = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'Please log in again' })

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const id = String(decoded.id || '')
    if (!id) return res.status(401).json({ error: 'Invalid token' })

    if (!(known.get(id) > Date.now())) {
      const exists = await User.findById(id).select('_id').lean()
      if (!exists) return res.status(401).json({ error: 'Account not found' })
      if (known.size > 5000) known.clear()
      known.set(id, Date.now() + KNOWN_TTL_MS)
    }

    req.user = { _id: id }
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}
