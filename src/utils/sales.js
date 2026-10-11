// Commission maths, shared by the admin panel and the salesperson's own page. Amounts in paise.
const cleanCode = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30)

// Commission is worked out on the value before GST
const commissionOf = (purchase, person) => {
  const pct = purchase.renewal ? Number(person.renewalPct) || 0 : Number(person.commissionPct) || 0
  return Math.round((Number(purchase.taxable) || 0) * pct / 100)
}

function summarise(person, purchases) {
  const rows = purchases
    .filter(p => p.status === 'paid' && cleanCode(p.salesCode) === person.code)
    .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt))
    .map(p => ({ ...p, commission: commissionOf(p, person) }))
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0)
  const unpaid = rows.filter(r => !r.commissionPaidAt)
  return {
    rows,
    totals: {
      sales: rows.length,
      newCustomers: rows.filter(r => !r.renewal).length,
      value: sum(rows, r => Number(r.taxable) || 0),
      commission: sum(rows, r => r.commission),
      commissionDue: sum(unpaid, r => r.commission),
      commissionPaid: sum(rows, r => r.commission) - sum(unpaid, r => r.commission),
    },
  }
}

const adminEmails = () => String(process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const isAdminEmail = (email) => adminEmails().includes(String(email || '').trim().toLowerCase())

module.exports = { cleanCode, commissionOf, summarise, isAdminEmail }
