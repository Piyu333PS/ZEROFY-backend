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

const Purchase = require('../models/Purchase')
const { nextNumber } = require('../models/Counter')
const { PLANS, ON_SALE, sellerInfo, quote, financialYear } = require('../utils/pricing')
const { stateCodeOf } = require('../utils/invoiceCalc')

const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max)
const GSTIN_RE = /^\d{2}[A-Z0-9]{13}$/

// Pro runs from today, or from the end of the time already paid for — a renewal never loses days
function extendExpiry(currentExpiry, days) {
  const now = new Date()
  const from = currentExpiry && new Date(currentExpiry) > now ? new Date(currentExpiry) : now
  from.setDate(from.getDate() + days)
  return from
}

// ─── Auto Pay availability ───────────────────────────────────────
// Razorpay charges an Auto Pay plan at the fixed price saved in the Razorpay dashboard.
// So Auto Pay is offered only when that saved price is exactly what we show the customer.
// After a price change (or once GST is switched on) create a new plan in Razorpay and put its
// id in RAZORPAY_PLAN_MONTHLY / RAZORPAY_PLAN_YEARLY — until then only one-time payment is offered.
const planAmountCache = {}
async function razorpayPlanAmount(planId) {
  const id = process.env[PLANS[planId].envKey]
  if (!id) return null
  const hit = planAmountCache[id]
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.amount
  try {
    const p = await razorpay.plans.fetch(id)
    const amount = Number(p && p.item && p.item.amount) || null
    planAmountCache[id] = { amount, at: Date.now() }
    return amount
  } catch (e) {
    console.warn('Could not read Razorpay plan', id, e.message)
    return null
  }
}
async function autoPayAvailable(planId, total) {
  return (await razorpayPlanAmount(planId)) === total
}

// Billing details from the checkout form — cleaned, with a list of what is wrong
function cleanBilling(raw = {}, email = '') {
  const b = {
    name: str(raw.name, 80), firm: str(raw.firm, 120), phone: str(raw.phone, 20).replace(/\D/g, '').slice(-10),
    email: str(email, 120), address: str(raw.address, 300), state: str(raw.state, 2),
    pincode: str(raw.pincode, 10).replace(/\D/g, ''), gstin: str(raw.gstin, 15).toUpperCase(),
  }
  const problems = []
  if (b.name.length < 2) problems.push('Enter your name')
  if (b.phone.length !== 10) problems.push('Enter a 10-digit mobile number')
  if (b.address.length < 5) problems.push('Enter your address')
  if (!/^\d{2}$/.test(b.state)) problems.push('Choose your state')
  if (!/^\d{6}$/.test(b.pincode)) problems.push('Enter a 6-digit PIN code')
  if (b.gstin && !GSTIN_RE.test(b.gstin)) problems.push('GSTIN must be 15 characters')
  else if (b.gstin && stateCodeOf(b.gstin) !== b.state) problems.push('The GSTIN does not match the state you chose')
  return { billing: b, problems }
}

async function receiptNumber() {
  const fy = financialYear()
  const n = await nextNumber(`receipt:${fy}`)
  return `ZF/${fy}/${String(n).padStart(4, '0')}`
}

// Mark a purchase as paid (once) and switch Pro on. Safe to call twice for the same payment.
async function completePurchase(purchase, paymentId, extraUserFields = {}) {
  const user = await User.findById(purchase.userId)
  if (!user) return null
  if (purchase.status === 'paid') return { purchase, proExpiry: user.proExpiry, already: true }

  const plan = PLANS[purchase.planId] || PLANS.monthly
  const proExpiry = extendExpiry(user.isPro ? user.proExpiry : null, plan.days)
  const receiptNo = await receiptNumber()
  const paid = await Purchase.findByIdAndUpdate(purchase._id, {
    status: 'paid', paymentId: paymentId || '', receiptNo, paidAt: new Date(),
  }, { new: true })
  await User.findByIdAndUpdate(user._id, {
    isPro: true, proExpiry, freeLimit: 999999, lastPlanId: plan.id,
    lastPaymentId: paymentId || '', invoiceCount: 0, ...extraUserFields,
  })
  return { purchase: paid, proExpiry }
}

// ─── GET /plans ──────────────────────────────────────────────────
// Plans on sale, whether GST is being charged, and whether Auto Pay can be offered for each
router.get('/plans', async (req, res) => {
  try {
    const seller = sellerInfo()
    const plans = []
    for (const id of ON_SALE) {
      const q = quote({ planId: id })
      plans.push({
        id, name: q.short, period: q.period, days: q.days,
        price: q.base, listPrice: q.listAmount, total: q.total,
        autoPay: await autoPayAvailable(id, q.total),
      })
    }
    res.json({ plans, gstEnabled: seller.gstEnabled, gstRate: seller.gstEnabled ? 18 : 0 })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load the plans' })
  }
})

// ─── GET /checkout-info ──────────────────────────────────────────
// Billing details to start the checkout form with: what was given last time,
// otherwise whatever the user already typed in their first business profile.
router.get('/checkout-info', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean()
    let billing = user.billing
    if (!billing) {
      const biz = (user.businesses || [])[0] || {}
      billing = {
        name: '', firm: biz.name || '', phone: String(biz.phone || '').replace(/\D/g, '').slice(-10),
        address: biz.addr || '', state: stateCodeOf(biz.gst), pincode: (String(biz.addr || '').match(/\b\d{6}\b/) || [''])[0],
        gstin: stateCodeOf(biz.gst) ? String(biz.gst).toUpperCase() : '',
      }
    }
    res.json({ success: true, billing: { ...billing, email: user.email }, isPro: Boolean(user.isPro && user.proExpiry && new Date(user.proExpiry) > new Date()), proExpiry: user.proExpiry })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /quote ─────────────────────────────────────────────────
// Price break-up for the order summary (plan, coupon, GST, total)
router.post('/quote', auth, async (req, res) => {
  const q = quote({ planId: req.body.planId, mode: req.body.mode === 'auto' ? 'auto' : 'once', couponCode: req.body.couponCode, state: req.body.state })
  if (q.error) return res.status(400).json({ error: q.error })
  res.json({ success: true, quote: q })
})

// ─── POST /checkout ──────────────────────────────────────────────
// Saves the billing details, records the purchase and opens a Razorpay order (one-time)
// or subscription (Auto Pay). The amount always comes from the server, never from the page.
router.post('/checkout', auth, async (req, res) => {
  try {
    const mode = req.body.mode === 'auto' ? 'auto' : 'once'
    const { billing, problems } = cleanBilling(req.body.billing, req.user.email)
    if (problems.length) return res.status(400).json({ error: problems[0], problems })

    const q = quote({ planId: req.body.planId, mode, couponCode: req.body.couponCode, state: billing.state })
    if (q.error) return res.status(400).json({ error: q.error })
    if (mode === 'auto' && !(await autoPayAvailable(q.planId, q.total))) {
      return res.status(400).json({ error: 'auto_pay_unavailable', message: 'Auto Pay is not available right now. Please choose one-time payment.' })
    }

    const seller = sellerInfo()
    const userId = req.user._id.toString()
    await User.findByIdAndUpdate(req.user._id, { billing })

    const purchase = new Purchase({
      userId: req.user._id, planId: q.planId, planName: q.planName, days: q.days, mode,
      base: q.base, discount: q.discount, taxable: q.taxable, gstRate: q.gstRate,
      cgst: q.cgst, sgst: q.sgst, igst: q.igst, tax: q.tax, total: q.total,
      couponCode: q.couponCode, salesCode: str(req.body.salesCode, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
      billing, seller: { name: seller.name, address: seller.address, email: seller.email, gstin: seller.gstin, state: seller.state, sac: seller.sac },
    })
    await purchase.save()
    const purchaseId = purchase._id.toString()
    const notes = { userId, planId: q.planId, purchaseId }

    const out = { success: true, mode, purchaseId, keyId: process.env.RAZORPAY_KEY_ID, amount: q.total, currency: 'INR', planName: q.planName, quote: q }
    if (mode === 'auto') {
      // An older Auto Pay, if any, is replaced by this one
      const user = await User.findById(req.user._id)
      if (user.subscriptionId) {
        try { await razorpay.subscriptions.cancel(user.subscriptionId) } catch (e) { console.warn('Could not cancel old subscription:', e.message) }
      }
      const subscription = await razorpay.subscriptions.create({
        plan_id: process.env[PLANS[q.planId].envKey], total_count: q.planId === 'yearly' ? 10 : 60, quantity: 1, customer_notify: 1, notes,
      })
      await Purchase.findByIdAndUpdate(purchase._id, { subscriptionId: subscription.id })
      await User.findByIdAndUpdate(req.user._id, { subscriptionId: subscription.id, subscriptionStatus: 'created' })
      out.subscriptionId = subscription.id
    } else {
      const order = await razorpay.orders.create({
        amount: q.total, currency: 'INR',
        receipt: `r_${userId.slice(-8)}_${Date.now().toString().slice(-8)}`, notes,
      })
      await Purchase.findByIdAndUpdate(purchase._id, { orderId: order.id })
      out.orderId = order.id
    }
    res.json(out)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not start the payment. Please try again.' })
  }
})

const validSignature = (payload, signature) =>
  crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(payload).digest('hex') === signature

// ─── POST /verify (one-time payment) ─────────────────────────────
router.post('/verify', auth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
    if (!razorpay_order_id || !validSignature(razorpay_order_id + '|' + razorpay_payment_id, razorpay_signature)) {
      return res.status(400).json({ error: 'Payment verification failed' })
    }
    // The plan comes from the purchase recorded for this order — never from the request body
    const purchase = await Purchase.findOne({ orderId: razorpay_order_id, userId: req.user._id })
    if (!purchase) return res.status(400).json({ error: 'Payment verification failed' })

    const done = await completePurchase(purchase, razorpay_payment_id)
    res.json({ success: true, message: `Pro is active for ${purchase.days} days.`, planId: purchase.planId, proExpiry: done.proExpiry, purchaseId: purchase._id })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not verify the payment. Please contact support.' })
  }
})

// ─── POST /verify-subscription (Auto Pay) ────────────────────────
router.post('/verify-subscription', auth, async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body
    if (!razorpay_subscription_id || !validSignature(razorpay_payment_id + '|' + razorpay_subscription_id, razorpay_signature)) {
      return res.status(400).json({ error: 'Subscription verification failed' })
    }
    const purchase = await Purchase.findOne({ subscriptionId: razorpay_subscription_id, userId: req.user._id, renewal: false })
    if (!purchase) return res.status(400).json({ error: 'Subscription verification failed' })

    const done = await completePurchase(purchase, razorpay_payment_id, { subscriptionId: razorpay_subscription_id, subscriptionStatus: 'active' })
    res.json({ success: true, message: 'Auto Pay is active. Your plan renews automatically.', planId: purchase.planId, proExpiry: done.proExpiry, purchaseId: purchase._id })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not verify the subscription. Please contact support.' })
  }
})

// ─── GET /purchases ──────────────────────────────────────────────
// Paid purchases of this account — the Billing page shows them with a downloadable invoice
router.get('/purchases', auth, async (req, res) => {
  try {
    const list = await Purchase.find({ userId: req.user._id, status: 'paid' }).sort({ paidAt: -1 }).lean()
    res.json({ success: true, purchases: list })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Older versions of the app called these. They would now show an old price, so ask for a refresh.
const refreshFirst = (req, res) => res.status(410).json({ error: 'Prices have changed. Please refresh the page and try again.' })
router.post('/validate-coupon', refreshFirst)
router.post('/create-order', refreshFirst)
router.post('/create-subscription', refreshFirst)

// ─── POST /cancel-subscription ───────────────────────────────────
router.post('/cancel-subscription', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)

    if (!user.subscriptionId) {
      return res.status(400).json({ error: 'No active subscription found' })
    }

    await razorpay.subscriptions.cancel(user.subscriptionId, { cancel_at_cycle_end: 1 })

    await User.findByIdAndUpdate(req.user._id, {
      subscriptionStatus: 'cancelled'
    })

    res.json({
      success: true,
      message: `Auto Pay will stop after ${user.proExpiry?.toDateString() || 'the current cycle'}. You keep Pro access until then.`
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not cancel the subscription. Please try again.' })
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
    res.status(500).json({ error: 'Could not load the subscription status.' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  WEBHOOK — Razorpay automatic renewals handle karo
//  Route: POST /api/payment/webhook
//  Razorpay Dashboard mein yeh URL add karo:
//  https://zerofy-backend.vercel.app/api/payment/webhook
// ═══════════════════════════════════════════════════════════════
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET
    const signature = req.headers['x-razorpay-signature']

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

      case 'subscription.charged': {
        const sub = payload.subscription.entity
        const payment = payload.payment.entity
        const userId = sub.notes?.userId

        if (!userId) break

        const user = await User.findById(userId)
        if (!user) break

        // The first charge is recorded by /verify-subscription; this can arrive before or after it.
        // Every later charge is a renewal and gets its own purchase record (and invoice number).
        const seen = await Purchase.findOne({ paymentId: payment.id })
        if (seen) break
        const first = await Purchase.findOne({ subscriptionId: sub.id, userId, renewal: false })
        let newExpiry
        if (first && first.status !== 'paid') {
          const done = await completePurchase(first, payment.id, { subscriptionId: sub.id, subscriptionStatus: 'active' })
          newExpiry = done && done.proExpiry
        } else {
          const plan = PLANS[(first && first.planId) || user.lastPlanId] || PLANS.monthly
          const amount = Number(payment.amount) || 0
          // Split what was actually charged into value and GST, using the rate of the first purchase
          const gstRate = first ? first.gstRate : 0
          const taxable = gstRate ? Math.round(amount * 100 / (100 + gstRate)) : amount
          const tax = amount - taxable
          const inter = Boolean(first && first.igst > 0)
          const renewal = new Purchase({
            userId, planId: plan.id, planName: plan.name, days: plan.days, mode: 'auto', renewal: true,
            base: taxable, taxable, gstRate, tax, total: amount,
            igst: inter ? tax : 0, cgst: inter ? 0 : Math.floor(tax / 2), sgst: inter ? 0 : tax - Math.floor(tax / 2),
            salesCode: first ? first.salesCode : '',
            billing: user.billing || (first && first.billing) || {}, seller: (first && first.seller) || {},
            subscriptionId: sub.id,
          })
          await renewal.save()
          const done = await completePurchase(renewal, payment.id, { subscriptionStatus: 'active' })
          newExpiry = done && done.proExpiry
        }

        console.log(`✅ Auto renewed: ${userId} → ${newExpiry}`)
        break
      }

      case 'subscription.halted': {
        const sub = payload.subscription.entity
        const userId = sub.notes?.userId

        if (!userId) break

        await User.findByIdAndUpdate(userId, {
          subscriptionStatus: 'halted'
        })

        console.log(`⚠️ Subscription halted: ${userId}`)
        break
      }

      case 'subscription.cancelled': {
        const sub = payload.subscription.entity
        const userId = sub.notes?.userId

        if (!userId) break

        await User.findByIdAndUpdate(userId, {
          subscriptionStatus: 'cancelled'
        })

        console.log(`❌ Subscription cancelled: ${userId}`)
        break
      }

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
