require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')

const authRoutes = require('./src/routes/auth')
const userRoutes = require('./src/routes/user')
const resumeRoutes = require('./src/routes/resume')
const paymentRoutes = require('./src/routes/payment')
const invoiceRoutes = require('./src/routes/invoices')

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

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/user', userRoutes)
app.use('/api/resume', resumeRoutes)
app.use('/api/payment', paymentRoutes)
app.use('/api/invoices', invoiceRoutes)

// Health check
app.get('/', (req, res) => res.json({ status: 'Zerofy Backend Running ✅' }))

// MongoDB connect
let isConnected = false
const connectDB = async () => {
  if (isConnected) return
  await mongoose.connect(process.env.MONGODB_URI)
  isConnected = true
  console.log('MongoDB connected ✅')
}

connectDB().catch(err => console.error('MongoDB connection error:', err))

// Local server (Vercel pe ye nahi chalega, but local dev ke liye)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT} ✅`))
}

module.exports = app
