// The link to the Sales Dashboard (sales.zerofy.co.in) — the one place where the sales team, their codes
// and their commission are kept for every product.
// Settings: SALES_HUB_URL (its address) and SALES_HUB_KEY (this product's secret key, made in the dashboard).
// Without them nothing is sent, and sales codes are checked against the list kept here.
const Purchase = require('../models/Purchase')

const base = () => String(process.env.SALES_HUB_URL || '').trim().replace(/\/+$/, '')
const key = () => String(process.env.SALES_HUB_KEY || '').trim()
const configured = () => Boolean(base() && key())

async function call(method, path, body) {
  const res = await fetch(`${base()}/api/ingest${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-product-key': key() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
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

// Send one paid purchase. Only the business name goes across — no phone, email or address.
async function pushSale(purchase) {
  if (!configured() || !purchase || purchase.status !== 'paid' || !purchase.salesCode || purchase.salesSyncedAt) return false
  try {
    // A customer's first payment earns the first-sale rate; every later one is a renewal
    const earlier = await Purchase.find({ userId: purchase.userId, status: 'paid' }).lean()
    const renewal = Boolean(purchase.renewal) || earlier.some(p => String(p._id) !== String(purchase._id) && p.paidAt && new Date(p.paidAt) < new Date(purchase.paidAt))
    const b = purchase.billing || {}
    await call('POST', '/sale', {
      externalId: String(purchase._id), code: purchase.salesCode,
      customer: b.firm || b.name || '', plan: purchase.planName || purchase.planId,
      amount: purchase.taxable, total: purchase.total, renewal, paidAt: purchase.paidAt,
    })
    await Purchase.findByIdAndUpdate(purchase._id, { salesSyncedAt: new Date() })
    return true
  } catch (e) {
    console.warn('Could not send the sale to the Sales Dashboard (it will be sent again by the daily job):', e.message)
    return false
  }
}

// Run by the daily job: send anything that did not go through at the time of payment
async function syncPending(limit = 100) {
  if (!configured()) return 0
  const waiting = await Purchase.find({ status: 'paid', salesSyncedAt: null, salesCode: { $ne: '' } }).sort({ paidAt: 1 }).lean()
  let sent = 0
  for (const p of waiting.slice(0, limit)) if (await pushSale(p)) sent++
  return sent
}

module.exports = { configured, checkCode, pushSale, syncPending }
