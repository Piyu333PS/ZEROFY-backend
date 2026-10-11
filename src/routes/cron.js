const express = require('express')
const User = require('../models/User')
const { mailConfigured, sendMail, layout } = require('../utils/mailer')
const salesHub = require('../utils/salesHub')

// Jobs that run on a timer (see "crons" in vercel.json — once a day).
// Vercel calls these with "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set; anyone else is refused.
const router = express.Router()
const DAY = 24 * 3600 * 1000
const SITE = 'https://www.zerofy.co.in'

function allowed(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.authorization === `Bearer ${secret}`
}

const dateText = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })

// Which reminder (if any) a user is due today. Each one is sent once per expiry date.
//   week  — Pro ends in 7 days or less (but more than 1)
//   day   — Pro ends within the next day
//   ended — Pro ended in the last 3 days
function reminderDue(user, now = Date.now()) {
  if (!user.isPro || !user.proExpiry) return null
  if (user.subscriptionStatus === 'active') return null // Auto Pay renews by itself
  const left = new Date(user.proExpiry).getTime() - now
  const stage = left <= -3 * DAY ? null : left <= 0 ? 'ended' : left <= DAY ? 'day' : left <= 7 * DAY ? 'week' : null
  if (!stage) return null
  const key = `${new Date(user.proExpiry).toISOString().slice(0, 10)}:${stage}`
  if ((user.expiryReminders || []).includes(key)) return null
  return { stage, key }
}

function reminderMail(user, stage) {
  const when = dateText(user.proExpiry)
  const name = ((user.businesses || [])[0] || {}).name || ''
  const hi = name ? `Hello ${name},` : 'Hello,'
  const button = `<a href="${SITE}/pricing" style="display:inline-block;background:#EFA02F;color:#12263F;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px;margin-top:6px">Renew Zerofy Pro</a>`
  const keep = '<p style="margin:16px 0 0;color:#5C7189;font-size:13px">All your invoices, clients and reports stay safe in your account either way.</p>'
  if (stage === 'ended') {
    return {
      subject: 'Your Zerofy Pro plan has ended',
      text: `${hi}\n\nYour Zerofy Pro plan ended on ${when}. Your account is now on the free plan, so new invoices are limited.\n\nRenew here: ${SITE}/pricing\n\nAll your invoices, clients and reports are safe in your account.\n\n— Zerofy`,
      html: layout('Your Pro plan has ended', `<p style="margin:0 0 14px;color:#44566B">${hi}<br><br>Your Zerofy Pro plan ended on <strong>${when}</strong>. Your account is now on the free plan, so new invoices are limited.</p>${button}${keep}`),
    }
  }
  const soon = stage === 'day' ? 'tomorrow' : `on ${when}`
  return {
    subject: stage === 'day' ? 'Your Zerofy Pro plan ends tomorrow' : `Your Zerofy Pro plan ends on ${when}`,
    text: `${hi}\n\nYour Zerofy Pro plan ends ${soon}. Renew now to keep making unlimited invoices — the new period is added after your current one, so you lose no days.\n\nRenew here: ${SITE}/pricing\n\n— Zerofy`,
    html: layout(stage === 'day' ? 'Your Pro plan ends tomorrow' : 'Your Pro plan ends soon', `<p style="margin:0 0 14px;color:#44566B">${hi}<br><br>Your Zerofy Pro plan ends <strong>${soon}</strong>. Renew now to keep making unlimited invoices. The new period is added after your current one, so you lose no days.</p>${button}${keep}`),
  }
}

// GET /api/cron/daily
router.get('/daily', async (req, res) => {
  if (!allowed(req)) return res.status(401).json({ error: 'Not allowed' })
  const out = { checked: 0, sent: 0, failed: 0, skipped: mailConfigured() ? '' : 'mail is not set up' }
  try {
    // Payments that did not reach the Sales Dashboard are sent again
    out.salesSynced = await salesHub.syncPending()
    out.customersSynced = await salesHub.syncCustomers()
    if (!mailConfigured()) return res.json(out)
    const users = await User.find({ isPro: true }).lean()
    out.checked = users.length
    for (const user of users) {
      const due = reminderDue(user)
      if (!due) continue
      if (out.sent >= 200) break // stay well inside the mailbox's daily limit; the rest go tomorrow
      try {
        await sendMail({ to: user.email, ...reminderMail(user, due.stage) })
        await User.findByIdAndUpdate(user._id, { expiryReminders: [...(user.expiryReminders || []).slice(-8), due.key] })
        out.sent++
      } catch (e) {
        console.error('Reminder mail failed for', user.email, e.message)
        out.failed++
      }
    }
    res.json(out)
  } catch (err) {
    console.error(err)
    res.status(500).json({ ...out, error: 'Server error' })
  }
})

module.exports = router
module.exports.reminderDue = reminderDue
