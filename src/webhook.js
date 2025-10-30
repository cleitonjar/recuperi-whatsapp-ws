import { getWebhook } from './db.js'

export async function postWebhook(session, payload) {
  try {
    const row = await getWebhook(session)
    const url = row?.url
    if (!url) return
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    console.log(JSON.stringify(payload))
  } catch (e) {
    console.error('webhook error:', e?.message || e)
  }
}
