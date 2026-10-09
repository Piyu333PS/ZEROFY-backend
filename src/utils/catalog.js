const Item = require('../models/Item')

const num = (v, fallback = 0) => {
  const n = Number(v)
  return isNaN(n) ? fallback : n
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

module.exports = { cleanItem, rememberItems }
