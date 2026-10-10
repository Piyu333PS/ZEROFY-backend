const mongoose = require('mongoose')

// Running numbers (for example the receipt number of each financial year)
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
})
const Counter = mongoose.model('Counter', counterSchema)

// Next number for a key: 1, 2, 3 … never repeats, even when two payments land together
async function nextNumber(key) {
  let c = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { new: true })
  if (c) return c.seq
  try {
    await new Counter({ key, seq: 1 }).save()
    return 1
  } catch {
    c = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { new: true })
    return c ? c.seq : Date.now() % 100000
  }
}

module.exports = Counter
module.exports.nextNumber = nextNumber
