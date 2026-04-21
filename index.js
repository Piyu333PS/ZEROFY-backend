require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')

const authRoutes = require('./src/routes/auth')
const userRoutes = require('./src/routes/user')
const resumeRoutes = require('./src/routes/resume')
const paymentRoutes = require('./src/routes/payment')

const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(cors({
  origin: ['https://www.zerofy.co.in', 'https://zerofy.co.in', 'http://localhost:5173'],
  credentials: true
}))
app.use(express.json())

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/user', userRoutes)
app.use('/api/resume', resumeRoutes)
app.use('/api/payment', paymentRoutes)

// Health check
app.get('/', (req, res) => res.json({ status: 'Zerofy Backend Running ✅' }))

// MongoDB connect
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected ✅')
    app.listen(PORT, () => console.log(`Server running on port ${PORT} ✅`))
  })
  .catch(err => console.error('MongoDB connection error:', err))
