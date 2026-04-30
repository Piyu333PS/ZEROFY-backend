const express = require('express')
const Razorpay = require('razorpay')
const crypto = require('crypto')
const auth = require('../middleware/auth')
const User = require('../models/User')

const router = express.Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
})

// ─── Plans config ───────────────────────────────────────────────
const PLANS = {
  monthly: {
    id: 'monthly',
    name: 'Pro Monthly',
    amount: 1900,       // ₹19 in paise
    currency: 'INR',
    days: 30,
    label: '₹19/month'
  },
  quarterly: {
    id: 'quarterly',
    name: 'Pro Quarterly',
    amount: 4900,       // ₹49 in paise
    currency: 'INR',
    days: 90,
    label: '₹49/quarter'
  },
  yearly: {
    id: 'yearly',
    name: 'Pro Yearly',
    amount: 19900,      // ₹199 in paise
    currency: 'INR',
    days: 365,
    label: '₹199/year'
  }
}

// ─── Coupon codes ────────────────────────────────────────────────
const COUPONS = {
  'ZEROFY10': { discount: 10, type: 'percent', desc: '10% off' },
  'ZEROFY20': { discount: 20, type: 'percent', desc: '20% off' },
  'FLAT50':   { discount: 50, type: 'flat',    desc: '₹50 flat off' },
  'WELCOME':  { discount: 15, type: 'percent', desc: '15% off for new users' },
  'LAUNCH':   { discount: 100, type: 'flat',   desc: '₹100 flat off' },
}

// ─── Helper: apply coupon ────────────────────────────────────────
function applyCoupon(amount, couponCode) {
  if (!couponCode) return { finalAmount: amount, discount: 0, valid: false }
  const coupon = COUPONS[couponCode.toUpperCase()]
  if (!coupon) return { finalAmount: amount, discount: 0, valid: false, error: 'Invalid coupon code' }

  let discountAmt = 0
  if (coupon.type === 'percent') {
    discountAmt = Math.floor(amount * coupon.discount / 100)
  } else {
    discountAmt = coupon.discount * 100 // convert ₹ to paise
  }

  const finalAmount = Math.max(100, amount - discountAmt) // min ₹1
  return { finalAmount, discount: discountAmt, valid: true, desc: coupon.desc }
}

// ─── GET /plans ──────────────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({ plans: PLANS })
})

// ─── POST /validate-coupon ───────────────────────────────────────
router.post('/validate-coupon', auth, (req, res) => {
  const { couponCode, planId } = req.body
  if (!planId || !PLANS[planId]) return res.status(400).json({ error: 'Invalid plan' })

  const plan = PLANS[planId]
  const result = applyCoupon(plan.amount, couponCode)

  if (!result.valid) return res.status(400).json({ error: result.error || 'Invalid coupon' })

  res.json({
    valid: true,
    desc: result.desc,
    originalAmount: plan.amount,
    discountAmount: result.discount,
    finalAmount: result.finalAmount
  })
})

// ─── POST /create-order ──────────────────────────────────────────
router.post('/create-order', auth, async (req, res) => {
  try {
    const { planId, couponCode } = req.body
    if (!planId || !PLANS[planId]) return res.status(400).json({ error: 'Invalid plan selected' })

    const plan = PLANS[planId]
    const { finalAmount } = applyCoupon(plan.amount, couponCode)

    const order = await razorpay.orders.create({
      amount: finalAmount,
      currency: plan.currency,
      receipt: `r_${req.user._id.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
      notes: {
        userId: req.user._id.toString(),
        planId,
        couponCode: couponCode || '',
        originalAmount: plan.amount,
        finalAmount
      }
    })

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      planId,
      planName: plan.name
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Order create karne mein error' })
  }
})

// ─── POST /verify ────────────────────────────────────────────────
router.post('/verify', auth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = req.body

    // Signature verification
    const sign = razorpay_order_id + '|' + razorpay_payment_id
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign)
      .digest('hex')

    if (expectedSign !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' })
    }

    const plan = PLANS[planId] || PLANS.monthly
    const proExpiry = new Date()
    proExpiry.setDate(proExpiry.getDate() + plan.days)

    await User.findByIdAndUpdate(req.user._id, {
      isPro: true,
      proExpiry,
      freeLimit: 999999,
      lastPlanId: planId,
      lastPaymentId: razorpay_payment_id
    })

    res.json({
      success: true,
      message: `🎉 Pro access activated! Valid for ${plan.days} days.`,
      planId,
      proExpiry
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Payment verify karne mein error' })
  }
})

module.exports = router
