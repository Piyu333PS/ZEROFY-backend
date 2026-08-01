require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')

const authRoutes = require('./src/routes/auth')
const userRoutes = require('./src/routes/user')
const resumeRoutes = require('./src/routes/resume')
const paymentRoutes = require('./src/routes/payment')
const invoiceRoutes = require('./src/routes/invoices')
const customerRoutes = require('./src/routes/customers')
const paymentsRoutes = require('./src/routes/payments')
const dashboardRoutes = require('./src/routes/dashboard')

const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(cors({
  origin: [
    'https://www.zerofy.co.in',
    'https://zerofy.co.in',
    'http://localhost:5173',
    'https://zerofy-backend.vercel.app'
  ],
  credentials: true
}))
app.use(express.json())

// MongoDB connect
let dbPromise = null
const connectDB = () => {
  if (mongoose.connection.readyState === 1) return Promise.resolve()
  if (!dbPromise) {
    dbPromise = mongoose.connect(process.env.MONGODB_URI)
      .then(() => console.log('MongoDB connected ✅'))
      .catch(err => {
        dbPromise = null  // agli request phir se try kare
        console.error('MongoDB connection error:', err)
        throw err
      })
  }
  return dbPromise
}

// Har request se pehle ensure karo DB connected hai — isse cold-start ke time
// connection abhi ban hi raha ho to request usse pehle fail nahi hogi
app.use(async (req, res, next) => {
  try {
    await connectDB()
    next()
  } catch (err) {
    res.status(503).json({ error: 'Database abhi available nahi hai, thodi der mein try karo' })
  }
})

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/user', userRoutes)
app.use('/api/resume', resumeRoutes)
app.use('/api/payment', paymentRoutes)
app.use('/api/invoices', invoiceRoutes)
app.use('/api/customers', customerRoutes)
app.use('/api/payments', paymentsRoutes)
app.use('/api/dashboard', dashboardRoutes)

// Health check
app.get('/', (req, res) => res.json({ status: 'Zerofy Backend Running ✅' }))

connectDB().catch(() => {})  // warm-up attempt, request middleware upar already retry karega

// Local server (Vercel pe ye nahi chalega, but local dev ke liye)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT} ✅`))
}

module.exports = app
