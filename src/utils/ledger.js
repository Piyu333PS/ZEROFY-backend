// One place that works out what each document is worth after payments and credit notes.
// Used by the bootstrap, invoice list, stats and client routes so every screen shows the same numbers.
const { invoiceTotal, r2 } = require('./invoiceCalc')

const DOC_TYPES = ['invoice', 'quotation', 'credit_note']
// Documents saved before document types existed have no docType — they are invoices.
const docTypeOf = (d) => (d && DOC_TYPES.includes(d.docType) ? d.docType : 'invoice')
const isBillable = (inv) => inv.status !== 'cancelled' && inv.status !== 'draft'

function sumBy(list, keyOf, valueOf) {
  const map = {}
  for (const x of list) {
    const k = keyOf(x)
    if (!k) continue
    map[k] = (map[k] || 0) + (Number(valueOf(x)) || 0)
  }
  return map
}

const paidMapOf = (payments) => sumBy(payments, p => String(p.invoiceId), p => p.amount)

// Credit notes that are not cancelled, added up per invoice they were raised against
const creditMapOf = (docs) => sumBy(
  docs.filter(d => docTypeOf(d) === 'credit_note' && d.status !== 'cancelled' && d.refInvoiceId),
  d => String(d.refInvoiceId),
  d => invoiceTotal(d)
)

function decorateInvoice(inv, paidMap = {}, creditMap = {}) {
  const total = invoiceTotal(inv)
  const paid = r2(paidMap[String(inv._id)] || 0)
  const credited = r2(creditMap[String(inv._id)] || 0)
  return {
    ...inv,
    docType: 'invoice',
    grandTotal: total,
    paidAmount: paid,
    creditedAmount: credited,
    balance: r2(Math.max(0, total - paid - credited)),
  }
}

const decorateOther = (doc) => ({ ...doc, docType: docTypeOf(doc), grandTotal: invoiceTotal(doc) })

// docs: every document of one user. payments: every payment of that user.
function buildLedger(docs, payments) {
  const paidMap = paidMapOf(payments)
  const creditMap = creditMapOf(docs)
  const invoices = [], quotations = [], creditNotes = []
  const byCustomer = {}
  let totalInvoiced = 0, received = 0, pending = 0

  for (const doc of docs) {
    const type = docTypeOf(doc)
    if (type === 'quotation') { quotations.push(decorateOther(doc)); continue }
    if (type === 'credit_note') { creditNotes.push(decorateOther(doc)); continue }
    const inv = decorateInvoice(doc, paidMap, creditMap)
    invoices.push(inv)
    if (!isBillable(inv)) continue
    const net = Math.max(0, inv.grandTotal - inv.creditedAmount)
    totalInvoiced += net
    received += inv.paidAmount
    pending += inv.balance
    if (inv.customerId) {
      const k = String(inv.customerId)
      if (!byCustomer[k]) byCustomer[k] = { invoiceCount: 0, billed: 0, received: 0, outstanding: 0 }
      byCustomer[k].invoiceCount += 1
      byCustomer[k].billed += net
      byCustomer[k].received += inv.paidAmount
      byCustomer[k].outstanding += inv.balance
    }
  }
  for (const k of Object.keys(byCustomer)) {
    const a = byCustomer[k]
    a.billed = r2(a.billed); a.received = r2(a.received); a.outstanding = r2(a.outstanding)
  }
  return {
    invoices, quotations, creditNotes, byCustomer,
    totals: { totalInvoiced: r2(totalInvoiced), received: r2(received), pending: r2(pending) },
  }
}

// An invoice is settled when payments plus credit notes cover it.
function settledStatus(inv, paid, credited) {
  if (inv.status === 'cancelled' || inv.status === 'draft') return inv.status
  const total = invoiceTotal(inv)
  const covered = (Number(paid) || 0) + (Number(credited) || 0)
  return covered > 0 && covered >= total - 0.01 ? 'paid' : 'sent'
}

module.exports = { DOC_TYPES, docTypeOf, isBillable, paidMapOf, creditMapOf, decorateInvoice, decorateOther, buildLedger, settledStatus }
