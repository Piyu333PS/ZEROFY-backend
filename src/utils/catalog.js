const Item = require('../models/Item')

const num = (v, fallback = 0) => {
  const n = Number(v)
  return isNaN(n) ? fallback : n
}

// GST rates the app offers. 40% is the GST 2.0 slab (from 22 Sep 2025); 12% and 28%
// stay for older invoices and the few goods still billed at those rates.
const GST_RATES = [0, 0.1, 0.25, 1.5, 3, 5, 7.5, 12, 18, 28, 40]

// '' when the item can be saved, otherwise what is wrong (checked before cleanItem clamps values)
function itemError(body = {}) {
  if (body.rate !== undefined && body.rate !== '' && (isNaN(Number(body.rate)) || Number(body.rate) < 0)) {
    return 'Rate cannot be negative'
  }
  if (body.gstRate !== undefined && body.gstRate !== '' && !GST_RATES.includes(Number(body.gstRate))) {
    return `GST % must be one of ${GST_RATES.join(', ')}`
  }
  const code = String(body.hsnSac || '').trim()
  if (code) {
    if (!/^\d+$/.test(code)) return 'HSN / SAC code must contain digits only'
    if (body.type === 'service' ? !/^99\d{4}$/.test(code) : ![4, 6, 8].includes(code.length)) {
      return body.type === 'service' ? 'SAC code must be 6 digits and start with 99' : 'HSN code must be 4, 6 or 8 digits'
    }
  }
  return ''
}

const cleanItem = (body = {}) => {
  const out = {}
  if (body.name !== undefined) out.name = String(body.name).trim().slice(0, 200)
  if (body.type !== undefined) out.type = body.type === 'service' ? 'service' : 'goods'
  if (body.hsnSac !== undefined) out.hsnSac = String(body.hsnSac).trim().slice(0, 20)
  if (body.uqc !== undefined) out.uqc = String(body.uqc || 'PCS').slice(0, 10)
  if (body.rate !== undefined) out.rate = Math.max(0, num(body.rate))
  if (body.gstRate !== undefined) out.gstRate = Math.min(100, Math.max(0, num(body.gstRate, 18)))
  return out
}

// Invoice save hote hi uske items "Saved items" mein aa jate hain (naam se match, case-insensitive).
// Naya ho to ban jata hai; pehle se ho to latest rate / GST / HSN se update ho jata hai.
// Ye best-effort hai — isme error aaye to invoice save par asar nahi padna chahiye.
async function rememberItems(userId, lines) {
  try {
    const wanted = new Map()
    for (const it of lines || []) {
      const name = String((it && it.desc) || '').trim()
      if (!name || name.length > 200) continue
      wanted.set(name.toLowerCase(), {
        name,
        type: it.type === 'service' ? 'service' : 'goods',
        hsnSac: String(it.hsnSac || it.hsn || '').trim(),
        uqc: it.uqc || 'PCS',
        rate: Math.max(0, num(it.rate)),
        gstRate: num(it.gstRate !== undefined ? it.gstRate : it.gst, 18),
      })
    }
    if (!wanted.size) return

    const existing = await Item.find({ userId }).lean()
    if (existing.length >= 2000) return
    const byName = new Map(existing.map(e => [String(e.name || '').trim().toLowerCase(), e]))

    const jobs = []
    for (const [key, data] of wanted) {
      const cur = byName.get(key)
      if (!cur) {
        jobs.push(new Item({ ...data, userId }).save())
      } else if (cur.rate !== data.rate || cur.gstRate !== data.gstRate || (data.hsnSac && cur.hsnSac !== data.hsnSac) || cur.uqc !== data.uqc || cur.type !== data.type) {
        const patch = { rate: data.rate, gstRate: data.gstRate, uqc: data.uqc, type: data.type }
        if (data.hsnSac) patch.hsnSac = data.hsnSac
        jobs.push(Item.findByIdAndUpdate(cur._id, patch))
      }
    }
    await Promise.all(jobs)
  } catch (e) {
    console.error('rememberItems error:', e)
  }
}

module.exports = { cleanItem, rememberItems, itemError, GST_RATES }
