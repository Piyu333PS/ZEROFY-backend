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
    amount: 1900,
    currency: 'INR',
    days: 30,
    label: '₹19/month',
    razorpayPlanId: process.env.RAZORPAY_PLAN_MONTHLY   // 🆕 Razorpay Dashboard pe banao
  },
  quarterly: {
    id: 'quarterly',
    name: 'Pro Quarterly',
    amount: 4900,
    currency: 'INR',
    days: 90,
    label: '₹49/quarter',
    razorpayPlanId: process.env.RAZORPAY_PLAN_QUARTERLY // 🆕 Razorpay Dashboard pe banao
  },
  yearly: {
    id: 'yearly',
    name: 'Pro Yearly',
    amount: 19900,
    currency: 'INR',
    days: 365,
    label: '₹199/year',
    razorpayPlanId: process.env.RAZORPAY_PLAN_YEARLY    // 🆕 Razorpay Dashboard pe banao
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
    discountAmt = coupon.discount * 100
  }

  const finalAmount = Math.max(100, amount - discountAmt)
  return { finalAmount, discount: discountAmt, valid: true, desc: coupon.desc }
}

// ─── Helper: proExpiry calculate karo ───────────────────────────
function calcExpiry(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

// ═══════════════════════════════════════════════════════════════
//  PURANE ROUTES — bilkul same, touch nahi kiye
// ═══════════════════════════════════════════════════════════════

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

// ─── POST /create-order (manual one-time — purana) ───────────────
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

// ─── POST /verify (manual one-time — purana) ─────────────────────
router.post('/verify', auth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = req.body

    const sign = razorpay_order_id + '|' + razorpay_payment_id
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign)
      .digest('hex')

    if (expectedSign !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' })
    }

    const plan = PLANS[planId] || PLANS.monthly
    const proExpiry = calcExpiry(plan.days)

    await User.findByIdAndUpdate(req.user._id, {
      isPro: true,
      proExpiry,
      freeLimit: 999999,
      lastPlanId: planId,
      lastPaymentId: razorpay_payment_id,
      invoiceCount: 0
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

// ═══════════════════════════════════════════════════════════════
//  🆕 AUTO PAY ROUTES — Razorpay Subscriptions
// ═══════════════════════════════════════════════════════════════

// ─── POST /create-subscription ───────────────────────────────────
// Frontend se call karo jab user "Auto Pay" choose kare
router.post('/create-subscription', auth, async (req, res) => {
  try {
    const { planId } = req.body
    const plan = PLANS[planId]

    if (!plan) return res.status(400).json({ error: 'Invalid plan' })
    if (!plan.razorpayPlanId) return res.status(400).json({ error: 'Auto Pay is plan ke liye available nahi' })

    // Agar user ki pehle se koi active subscription hai, cancel karo
    const user = await User.findById(req.user._id)
    if (user.subscriptionId) {
      try {
        await razorpay.subscriptions.cancel(user.subscriptionId)
      } catch (e) {
        console.warn('Old subscription cancel nahi hui:', e.message)
      }
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.razorpayPlanId,
      total_count: 12,          // max 12 cycles (monthly=1yr, quarterly=3yr, yearly=12yr)
      quantity: 1,
      customer_notify: 1,       // Razorpay khud SMS/email bhejega
      notes: {
        userId: req.user._id.toString(),
        planId
      }
    })

    // DB mein subscriptionId save karo (pending state mein)
    await User.findByIdAndUpdate(req.user._id, {
      subscriptionId: subscription.id,
      subscriptionStatus: 'created',
      lastPlanId: planId
    })

    res.json({
      subscriptionId: subscription.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      planId,
      planName: plan.name
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Subscription create karne mein error' })
  }
})

// ─── POST /verify-subscription ───────────────────────────────────
// Pehli payment ke baad frontend se call karo
router.post('/verify-subscription', auth, async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature
    } = req.body

    // Signature verify karo
    const sign = razorpay_payment_id + '|' + razorpay_subscription_id
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign)
      .digest('hex')

    if (expectedSign !== razorpay_signature) {
      return res.status(400).json({ error: 'Subscription verification failed' })
    }

    const user = await User.findById(req.user._id)
    const plan = PLANS[user.lastPlanId] || PLANS.monthly
    const proExpiry = calcExpiry(plan.days)

    await User.findByIdAndUpdate(req.user._id, {
      isPro: true,
      proExpiry,
      freeLimit: 999999,
      subscriptionId: razorpay_subscription_id,
      subscriptionStatus: 'active',
      lastPaymentId: razorpay_payment_id,
      invoiceCount: 0
    })

    res.json({
      success: true,
      message: `🎉 Auto Pay active! Har ${plan.days} din pe automatically renew hoga.`,
      planId: user.lastPlanId,
      proExpiry
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Subscription verify karne mein error' })
  }
})

// ─── POST /cancel-subscription ───────────────────────────────────
// User jab cancel kare
router.post('/cancel-subscription', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)

    if (!user.subscriptionId) {
      return res.status(400).json({ error: 'Koi active subscription nahi mili' })
    }

    // cancel_at_cycle_end: true — current cycle khatam hone tak Pro rahega
    await razorpay.subscriptions.cancel(user.subscriptionId, { cancel_at_cycle_end: 1 })

    await User.findByIdAndUpdate(req.user._id, {
      subscriptionStatus: 'cancelled'
      // isPro aur proExpiry touch nahi kiye — expiry tak Pro rahega
    })

    res.json({
      success: true,
      message: `Auto Pay cancel ho jayega ${user.proExpiry?.toDateString() || 'cycle end'} ke baad. Tab tak Pro access rahega.`
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Subscription cancel karne mein error' })
  }
})

// ─── GET /subscription-status ────────────────────────────────────
router.get('/subscription-status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      'isPro proExpiry subscriptionId subscriptionStatus lastPlanId'
    )

    res.json({
      isPro: user.isPro,
      proExpiry: user.proExpiry,
      subscriptionId: user.subscriptionId || null,
      subscriptionStatus: user.subscriptionStatus || null,
      planId: user.lastPlanId || null,
      isAutoRenew: user.subscriptionStatus === 'active'
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Status fetch karne mein error' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  🆕 WEBHOOK — Razorpay automatic renewals handle karo
//  Route: POST /api/payment/webhook
//  Razorpay Dashboard mein yeh URL add karo
// ═══════════════════════════════════════════════════════════════
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET
    const signature = req.headers['x-razorpay-signature']

    // Webhook signature verify karo
    const expectedSign = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.body)
      .digest('hex')

    if (expectedSign !== signature) {
      console.error('Invalid webhook signature')
      return res.status(400).json({ error: 'Invalid signature' })
    }

    const event = JSON.parse(req.body)
    const payload = event.payload

    console.log('Razorpay Webhook:', event.event)

    switch (event.event) {

      // ✅ Automatic renewal successful
      case 'subscription.charged': {
        const sub = payload.subscription.entity
        const payment = payload.payment.entity
        const userId = sub.notes?.userId

        if (!userId) break

        const user = await User.findById(userId)
        if (!user) break

        const plan = PLANS[user.lastPlanId] || PLANS.monthly
        const newExpiry = calcExpiry(plan.days)

        await User.findByIdAndUpdate(userId, {
          isPro: true,
          proExpiry: newExpiry,
          freeLimit: 999999,
          subscriptionStatus: 'active',
          lastPaymentId: payment.id
        })

        console.log(`✅ Auto renewed: ${userId} → ${newExpiry}`)
        break
      }

      // ❌ Payment fail — grace period do, isPro false mat karo abhi
      case 'subscription.halted': {
        const sub = payload.subscription.entity
        const userId = sub.notes?.userId

        if (!userId) break

        await User.findByIdAndUpdate(userId, {
          subscriptionStatus: 'halted'
          // isPro abhi false nahi kiya — user ko retry ka time do
        })

        console.log(`⚠️ Subscription halted: ${userId}`)
        // TODO: Email/push notification bhejo user ko
        break
      }

      // 🚫 User ne cancel kiya ya cycle end pe cancel
      case 'subscription.cancelled': {
        const sub = payload.subscription.entity
        const userId = sub.notes?.userId

        if (!userId) break

        await User.findByIdAndUpdate(userId, {
          subscriptionStatus: 'cancelled'
          // isPro proExpiry tak true rahega
        })

        console.log(`❌ Subscription cancelled: ${userId}`)
        break
      }

      // subscription.activated — pehli baar active
      case 'subscription.activated': {
        const sub = payload.subscription.entity
        const userId = sub.notes?.userId

        if (!userId) break

        await User.findByIdAndUpdate(userId, {
          subscriptionStatus: 'active'
        })

        console.log(`🟢 Subscription activated: ${userId}`)
        break
      }

      default:
        console.log('Unhandled event:', event.event)
    }

    res.json({ received: true })
  } catch (err) {
    console.error('Webhook error:', err)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

module.exports = router
