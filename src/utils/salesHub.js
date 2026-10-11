// The link to the Sales Dashboard (sales.zerofy.co.in) — the one place where the sales team, their codes
// and their commission are kept for every product.
// Settings: SALES_HUB_URL (its address) and SALES_HUB_KEY (this product's secret key, made in the dashboard).
// Without them nothing is sent, and sales codes are checked against the list kept here.
const Purchase = require('../models/Purchase')
const User = require('../models/User')

const base = () => String(process.env.SALES_HUB_URL || '').trim().replace(/\/+$/, '')
const key = () => String(process.env.SALES_HUB_KEY || '').trim()
const configured = () => Boolean(base() && key())

async function call(method, path, body, ms = 6000) {
  const res = await fetch(`${base()}/api/ingest${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-product-key': key() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(ms),
  })
  if (!res.ok) throw new Error(`Sales Dashboard answered ${res.status}`)
  return res.json()
}

// Is this a salesperson's code? If the dashboard cannot be reached the code is still accepted,
// so a sale is never lost: it is kept with the payment and matched to the person later.
async function checkCode(code) {
  try {
    const r = await call('GET', `/code/${encodeURIComponent(code)}`)
    return r.valid ? { valid: true, code: r.code, name: r.name || '' } : { valid: false }
  } catch (e) {
    console.warn('Sales code check failed:', e.message)
    return { valid: true, code, name: '' }
  }
}

// Send one paid purchase — with a sales code, or without one (a direct sale). Only the business name goes across — no phone, email or address.
async function pushSale(purchase) {
  if (!configured() || !purchase || purchase.status !== 'paid' || purchase.salesSyncedAt) return false
  try {
    // A customer's first payment earns the first-sale rate; every later one is a renewal
    const earlier = await Purchase.find({ userId: purchase.userId, status: 'paid' }).lean()
    const renewal = Boolean(purchase.renewal) || earlier.some(p => String(p._id) !== String(purchase._id) && p.paidAt && new Date(p.paidAt) < new Date(purchase.paidAt))
    const b = purchase.billing || {}
    await call('POST', '/sale', {
      externalId: String(purchase._id), code: purchase.salesCode || '', customerRef: String(purchase.userId), couponCode: purchase.couponCode || '',
      customer: b.firm || b.name || '', plan: purchase.planName || purchase.planId,
      amount: purchase.taxable, total: purchase.total, renewal, paidAt: purchase.paidAt,
    })
    await Purchase.findByIdAndUpdate(purchase._id, { salesSyncedAt: new Date() })
    await pushCustomers([await User.findById(purchase.userId).lean()])   // their plan just changed
    return true
  } catch (e) {
    console.warn('Could not send the sale to the Sales Dashboard (it will be sent again by the daily job):', e.message)
    return false
  }
}

// Run by the daily job: send anything that did not go through at the time of payment
async function syncPending(limit = 100) {
  if (!configured()) return 0
  const waiting = await Purchase.find({ status: 'paid', salesSyncedAt: null }).sort({ paidAt: 1 }).lean()
  let sent = 0
  for (const p of waiting.slice(0, limit)) if (await pushSale(p)) sent++
  return sent
}

// Is this discount code good? Codes are made by the owner in the Sales Dashboard.
// (The private TEST_COUPON never goes there — pricing.js handles it.)
async function checkCoupon(code) {
  const key = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30)
  if (!key) return null
  const test = String(process.env.TEST_COUPON || '').trim().toUpperCase()
  if (test.length >= 8 && key === test) return null
  if (!configured()) return { valid: false, error: 'This coupon code is not valid' }
  try {
    const r = await call('GET', `/coupon/${encodeURIComponent(key)}`)
    return r.valid ? { valid: true, code: r.code, percent: r.percent } : { valid: false, error: r.error || 'This coupon code is not valid' }
  } catch (e) {
    console.warn('Coupon check failed:', e.message)
    return { valid: false, error: 'Could not check the coupon right now. Please try again in a minute.' }
  }
}

// What the owner sees about one customer in the Sales Dashboard
function customerRow(u) {
  const biz = (u.businesses || [])[0] || {}
  const bill = u.billing || {}
  const live = Boolean(u.isPro && u.proExpiry && new Date(u.proExpiry) > new Date())
  return {
    ref: String(u._id), name: bill.name || '', business: biz.name || bill.firm || '', email: u.email || '',
    phone: biz.phone || bill.phone || '', place: biz.addr || bill.address || '',
    paid: live, plan: u.lastPlanId ? `Pro — ${u.lastPlanId}` : '', planEnds: u.proExpiry || null,
    autoRenew: u.subscriptionStatus === 'active', joinedAt: u.createdAt || null,
  }
}

async function pushCustomers(users) {
  const list = (users || []).filter(Boolean)
  if (!configured() || !list.length) return 0
  try {
    let saved = 0
    for (let i = 0; i < list.length; i += 100) saved += (await call('POST', '/customers', { customers: list.slice(i, i + 100).map(customerRow) }, 20000)).saved || 0
    return saved
  } catch (e) { console.warn('Could not send customers to the Sales Dashboard:', e.message); return 0 }
}

// Run by the daily job: the whole customer list, so plan dates and new sign-ups stay up to date
async function syncCustomers() {
  if (!configured()) return 0
  return pushCustomers(await User.find({}).lean())
}

module.exports = { configured, checkCode, checkCoupon, pushSale, syncPending, pushCustomers, syncCustomers }
