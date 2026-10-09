// Invoice ka poora hisaab ek hi jagah — routes (dashboard, payments, invoices) sab yahi use karte hain.
// Frontend mein iski mirror copy hai: src/utils/invoiceCalc.js — dono ko saath mein badalna.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

// GSTIN ke pehle 2 digit = state code
const stateCodeOf = (gstin) => {
  const m = String(gstin || '').trim().match(/^(\d{2})[A-Z0-9]{13}$/i)
  return m ? m[1] : ''
}

// Purane invoices mein per-item rate `gst` field mein tha, naye mein `gstRate` mein
const itemGstRate = (it, inv) => {
  const candidates = [it && it.gstRate, it && it.gst, inv && inv.taxPct]
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '' && !isNaN(Number(c))) return Number(c)
  }
  return 18
}

const isInterState = (inv) => {
  const seller = stateCodeOf(inv.bizGst)
  const pos = String(inv.placeOfSupply || '').trim() || stateCodeOf(inv.clientGst)
  return Boolean(seller && pos && seller !== pos)
}

function calcInvoice(inv = {}) {
  const discPct = Math.min(100, Math.max(0, Number(inv.discPct) || 0))
  let sub = 0, disc = 0, gst = 0
  const lines = (inv.items || [])
    .filter(it => it && (it.desc || Number(it.rate)))
    .map(it => {
      const qty = Number(it.qty) || 0
      const rate = Number(it.rate) || 0
      const gross = qty * rate
      const lineDisc = gross * discPct / 100
      const taxable = gross - lineDisc
      const gstRate = itemGstRate(it, inv)
      const gstAmt = taxable * gstRate / 100
      sub += gross; disc += lineDisc; gst += gstAmt
      return { ...it, qty, rate, gross: r2(gross), taxable: r2(taxable), gstRate, gstAmt: r2(gstAmt), total: r2(taxable + gstAmt) }
    })
  const inter = isInterState(inv)
  const shipping = Math.max(0, Number(inv.shipping) || 0)
  const raw = sub - disc + gst + shipping
  const total = inv.roundOff ? Math.round(raw) : r2(raw)
  return {
    lines,
    sub: r2(sub), disc: r2(disc), taxable: r2(sub - disc), gst: r2(gst),
    inter,
    cgst: inter ? 0 : r2(gst / 2), sgst: inter ? 0 : r2(gst / 2), igst: inter ? r2(gst) : 0,
    shipping: r2(shipping),
    roundAdj: r2(total - raw),
    total,
  }
}

const invoiceTotal = (inv) => calcInvoice(inv).total

module.exports = { r2, stateCodeOf, itemGstRate, isInterState, calcInvoice, invoiceTotal }
