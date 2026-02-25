// api/waitlist.js — Vercel Serverless Function
// Handles multi-step lead capture: Brevo contact creation + Slack notifications

const BREVO_URL = 'https://api.brevo.com/v3'
const LIST_LEAD_1 = 74   // Lead étape 1 (email capturé)
const LIST_LEAD_2 = 75   // Lead étape 2 (inscription complète)

async function notifySlack(blocks) {
  const webhook = process.env.SLACK_WEBHOOK_URL
  if (!webhook) return
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  }).catch(err => console.error('Slack webhook error:', err))
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const BREVO_API_KEY = process.env.BREVO_API_KEY
  if (!BREVO_API_KEY) {
    console.error('BREVO_API_KEY non configurée')
    return res.status(500).json({ error: 'Config serveur manquante' })
  }

  const brevoHeaders = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'api-key': BREVO_API_KEY,
  }

  try {
    const { step, prenom, nom, email, profession, projets, telephone } = req.body

    // ━━━ ÉTAPE 1 — Créer le contact dès qu'on a l'email ━━━
    if (step === 1) {
      if (!prenom || !nom || !email) {
        return res.status(400).json({ error: 'Champs obligatoires manquants' })
      }

      const r = await fetch(`${BREVO_URL}/contacts`, {
        method: 'POST',
        headers: brevoHeaders,
        body: JSON.stringify({
          email,
          attributes: { PRENOM: prenom, NOM: nom, ETAPE_FORMULAIRE: 'etape_1_email' },
          listIds: [LIST_LEAD_1],
          updateEnabled: true,
        }),
      })

      const data = await r.json().catch(() => ({}))

      if (!r.ok && r.status !== 204) {
        if (data?.code === 'duplicate_parameter') {
          // Contact existe déjà → mise à jour
          await fetch(`${BREVO_URL}/contacts/${encodeURIComponent(email)}`, {
            method: 'PUT',
            headers: brevoHeaders,
            body: JSON.stringify({
              attributes: { PRENOM: prenom, NOM: nom, ETAPE_FORMULAIRE: 'etape_1_email' },
              listIds: [LIST_LEAD_1],
            }),
          }).catch(err => console.error('Update existing contact error:', err))
        } else {
          console.error('Brevo step 1 error:', r.status, data)
          return res.status(500).json({ error: `Erreur Brevo: ${data?.message || r.status}` })
        }
      }

      // Slack — lead capturé
      await notifySlack([
        { type: 'header', text: { type: 'plain_text', text: '🆕 Nouveau lead Masterlib', emoji: true } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Prénom :*\n${prenom}` },
          { type: 'mrkdwn', text: `*Nom :*\n${nom}` },
          { type: 'mrkdwn', text: `*Email :*\n<mailto:${email}|${email}>` },
          { type: 'mrkdwn', text: `*Étape :*\n1/2 (email capturé)` },
        ]},
        { type: 'context', elements: [
          { type: 'mrkdwn', text: '⏳ Lead en cours — séquence nurture déclenchée' }
        ]},
        { type: 'divider' }
      ])

      return res.status(200).json({ success: true })
    }

    // ━━━ ÉTAPE 2 — Inscription complète ━━━
    if (step === 2) {
      if (!email || !profession || !projets || !telephone) {
        return res.status(400).json({ error: 'Champs manquants' })
      }

      // Nettoyage téléphone
      let phoneClean = telephone.replace(/[\s.\-\(\)]/g, '')
      if (phoneClean.startsWith('0033')) phoneClean = '+33' + phoneClean.slice(4)
      else if (phoneClean.startsWith('33') && !phoneClean.startsWith('+')) phoneClean = '+33' + phoneClean.slice(2)
      else if (phoneClean.startsWith('0')) phoneClean = '+33' + phoneClean.slice(1)
      else if (!phoneClean.startsWith('+')) phoneClean = '+33' + phoneClean

      // Brevo — mise à jour contact + liste lead 2
      await fetch(`${BREVO_URL}/contacts/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: brevoHeaders,
        body: JSON.stringify({
          attributes: {
            PROFESSION: profession,
            NB_PROJETS: projets,
            SMS: phoneClean,
            ETAPE_FORMULAIRE: 'complet',
          },
          listIds: [LIST_LEAD_2],
        }),
      })

      // Retirer de la liste lead 1 (nurture)
      await fetch(`${BREVO_URL}/contacts/lists/${LIST_LEAD_1}/contacts/remove`, {
        method: 'POST',
        headers: brevoHeaders,
        body: JSON.stringify({ emails: [email] }),
      }).catch(err => console.error('Remove from lead 1 list error:', err))

      // Slack — inscription complète
      await notifySlack([
        { type: 'header', text: { type: 'plain_text', text: '🏗️ Lead Masterlib complet !', emoji: true } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Prénom :*\n${prenom || '—'}` },
          { type: 'mrkdwn', text: `*Nom :*\n${nom || '—'}` },
          { type: 'mrkdwn', text: `*Email :*\n<mailto:${email}|${email}>` },
          { type: 'mrkdwn', text: `*Téléphone :*\n${phoneClean}` },
        ]},
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Profession :*\n${profession}` },
          { type: 'mrkdwn', text: `*Projets/an :*\n${projets}` },
        ]},
        { type: 'context', elements: [
          { type: 'mrkdwn', text: '✅ Lead qualifié — à rappeler rapidement !' }
        ]},
        { type: 'divider' }
      ])

      return res.status(200).json({ success: true })
    }

    return res.status(400).json({ error: 'Étape invalide' })

  } catch (error) {
    console.error('Waitlist API error:', error)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}
