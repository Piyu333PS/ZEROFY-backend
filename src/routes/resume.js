const express = require('express')
const OpenAI = require('openai')
const auth = require('../middleware/auth')
const User = require('../models/User')

const router = express.Router()
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

router.post('/generate', auth, async (req, res) => {
  try {
    const user = req.user

    // Check limit
    if (!user.isPro && user.resumeCount >= user.freeLimit) {
      return res.status(403).json({ error: 'Free limit khatam', paywall: true })
    }

    const { formData, experiences, educations, techSkills, softSkills, languages, certifications } = req.body

    const prompt = `Tu ek professional resume writer hai. Niche diye gaye details se ek ATS-optimized resume banao.

User Details:
- Naam: ${formData.name}
- Phone: ${formData.phone}
- Email: ${formData.email}
- Location: ${formData.location || 'N/A'}
- LinkedIn/Portfolio: ${formData.linkedin || 'N/A'}
- Target Job: ${formData.jobTitle}
- Target Company: ${formData.targetCompany || 'N/A'}

Work Experience:
${experiences.map((e, i) => `${i+1}. ${e.role} at ${e.company} (${e.duration})\n   ${e.description}`).join('\n')}

Education:
${educations.map((e, i) => `${i+1}. ${e.degree} from ${e.institution} (${e.year}) - ${e.score}`).join('\n')}

Technical Skills: ${techSkills.join(', ')}
Soft Skills: ${softSkills.join(', ')}
Languages: ${languages.join(', ')}
Certifications: ${certifications.join(', ')}

Please create a professional resume summary (3-4 lines), and improve the work experience bullet points to be more impactful and ATS-friendly. Return as JSON:
{
  "summary": "Professional summary here",
  "improvedExperiences": [
    { "role": "", "company": "", "duration": "", "bullets": ["bullet1", "bullet2", "bullet3"] }
  ]
}`

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    })

    const aiData = JSON.parse(completion.choices[0].message.content)

    // Increment resume count
    await User.findByIdAndUpdate(user._id, { $inc: { resumeCount: 1 } })

    res.json({
      ...aiData,
      formData,
      experiences,
      educations,
      techSkills,
      softSkills,
      languages,
      certifications
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Resume generate karne mein error aaya' })
  }
})

module.exports = router
