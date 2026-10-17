// Server-side copies of the checks the app runs, so a bad GSTIN or a duplicate
// client cannot slip in through an old app version or a direct API call.

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const validState = (code) => (code >= 1 && code <= 38) || code === 97 || code === 99

function gstinCheckChar(first14) {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const p = GST_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(p / 36) + (p % 36)
  }
  return GST_CHARS[(36 - (sum % 36)) % 36]
}

// '' when fine (or empty), otherwise a short message a user understands
function gstinError(raw) {
  const v = String(raw || '').trim().toUpperCase()
  if (!v) return ''
  if (v.length !== 15) return 'GSTIN must be 15 characters'
  if (!GSTIN_RE.test(v) || !validState(Number(v.slice(0, 2))) || gstinCheckChar(v) !== v[14]) {
    return 'GSTIN is not valid. Please check the number'
  }
  return ''
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

module.exports = { gstinError, gstinCheckChar, escapeRe }
