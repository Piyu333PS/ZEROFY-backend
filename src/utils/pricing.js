// Zerofy Pro prices, coupons and GST — one place. All amounts are in paise (₹1 = 100).
const { stateCodeOf } = require('./invoiceCalc')

const PLANS = {
  monthly: { id: 'monthly', name: 'Zerofy Pro — Monthly', short: 'Monthly', amount: 14900, listAmount: 14900, days: 30, period: 'month', envKey: 'RAZORPAY_PLAN_MONTHLY' },
  yearly: { id: 'yearly', name: 'Zerofy Pro — Yearly', short: 'Yearly', amount: 99900, listAmount: 149900, days: 365, period: 'year', envKey: 'RAZORPAY_PLAN_YEARLY' },
  // No longer sold. Kept so that people already on it keep renewing correctly.
  quarterly: { id: 'quarterly', name: 'Zerofy Pro — Quarterly', short: 'Quarterly', amount: 12900, listAmount: 12900, days: 90, period: '3 months', envKey: 'RAZORPAY_PLAN_QUARTERLY', legacy: true },
}
const ON_SALE = ['monthly', 'yearly']

// Coupons work on one-time payments only (Razorpay charges an Auto Pay plan at its fixed price)
const COUPONS = {
  ZEROFY10: { discount: 10, type: 'percent', desc: '10% off' },
  ZEROFY20: { discount: 20, type: 'percent', desc: '20% off' },
  WELCOME: { discount: 15, type: 'percent', desc: '15% off for new users' },
  FLAT50: { discount: 50, type: 'flat', desc: '₹50 off' },
  LAUNCH: { discount: 100, type: 'flat', desc: '₹100 off' },
}

const GST_RATE = 18

// GST is charged only once the seller's GSTIN is set in the server settings (SELLER_GSTIN).
// Until then every bill is a plain invoice with no tax line.
function sellerInfo() {
  const gstin = String(process.env.SELLER_GSTIN || '').trim().toUpperCase()
  const state = stateCodeOf(gstin)
  return {
    name: process.env.SELLER_NAME || 'Zerofy',
    address: process.env.SELLER_ADDRESS || 'Jaipur, Rajasthan, India',
    email: process.env.SELLER_EMAIL || 'support@zerofy.co.in',
    gstin: state ? gstin : '',
    state,
    sac: process.env.SELLER_SAC || '997331',
    gstEnabled: Boolean(state),
  }
}

function couponFor(code, base) {
  const key = String(code || '').trim().toUpperCase()
  if (!key) return { code: '', discount: 0 }
  const c = COUPONS[key]
  if (!c) return { code: '', discount: 0, error: 'This coupon code is not valid' }
  let off = c.type === 'percent' ? Math.floor(base * c.discount / 100) : c.discount * 100
  off = Math.min(off, base - 100) // at least ₹1 stays payable
  return { code: key, discount: Math.max(0, off), desc: c.desc }
}

// Full price break-up for a plan. `state` is the buyer's 2-digit GST state code.
function quote({ planId, mode = 'once', couponCode = '', state = '' }) {
  const plan = PLANS[planId]
  if (!plan || !ON_SALE.includes(planId)) return { error: 'Choose a plan' }
  const seller = sellerInfo()
  const base = plan.amount
  let coupon = { code: '', discount: 0 }
  if (String(couponCode || '').trim()) {
    if (mode === 'auto') return { error: 'Coupons work with one-time payment only. Switch to one-time payment to use a coupon.' }
    coupon = couponFor(couponCode, base)
    if (coupon.error) return { error: coupon.error }
  }
  const taxable = base - coupon.discount
  let cgst = 0, sgst = 0, igst = 0
  if (seller.gstEnabled) {
    const tax = Math.round(taxable * GST_RATE / 100)
    const buyerState = String(state || '').trim()
    if (buyerState && buyerState !== seller.state) igst = tax
    else { cgst = Math.floor(tax / 2); sgst = tax - cgst }
  }
  const tax = cgst + sgst + igst
  return {
    planId, planName: plan.name, short: plan.short, period: plan.period, days: plan.days, mode,
    base, listAmount: plan.listAmount,
    couponCode: coupon.code, couponDesc: coupon.desc || '', discount: coupon.discount,
    taxable, gstEnabled: seller.gstEnabled, gstRate: seller.gstEnabled ? GST_RATE : 0,
    cgst, sgst, igst, tax, total: taxable + tax,
  }
}

// Indian financial year of a date: April 2026 – March 2027 → "26-27"
function financialYear(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`
}

module.exports = { PLANS, ON_SALE, COUPONS, GST_RATE, sellerInfo, quote, financialYear }
