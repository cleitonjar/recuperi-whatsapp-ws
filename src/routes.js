import express from 'express'
import { getSocket, getStatus, getQrPng, resolveValidJid, logoutSession } from './baileys.js'
import { setWebhook, getMsg, markBotMessage } from './db.js'

const router = express.Router()

router.get('/:session/status', async (req, res) => {
  const { session } = req.params
  await getSocket(session)
  const s = getStatus(session)
  res.json({ session, ...s })
})

router.get('/:session/qr', async (req, res) => {
  const { session } = req.params
  await getSocket(session)
  const png = await getQrPng(session)
  if (!png) return res.status(202).json({ ok: false, message: 'Aguardando QR ou já autenticado' })
  res.setHeader('Content-Type', 'image/png')
  res.send(png)
})

router.post('/:session/webhook', async (req, res) => {
  const { session } = req.params
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ ok: false, error: 'Informe url' })
  try {
    await setWebhook(session, url)
    res.json({ ok: true, session, url })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) })
  }
})

router.post('/:session/send', async (req, res) => {
  const { session } = req.params
  const { to, ...payload } = req.body || {}
  if (!to) return res.status(400).json({ ok: false, error: "Campos 'to' é obrigatório" })
  try {
    const sock = await getSocket(session)
    const jid = await resolveValidJid(sock, to)

    const m = await sock.sendMessage(jid, payload)
    await markBotMessage(session, m.key.id)
    res.json({ ok: true, messageId: m.key.id, to: jid })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) })
  }
})

async function resolveGroupJid(sock, { groupJid, groupName }) {
  if (groupJid) return groupJid.endsWith('@g.us') ? groupJid : `${groupJid}@g.us`
  if (!groupName) return null
  const groups = await sock.groupFetchAllParticipating()
  const list = Object.values(groups || {})
  const found = list.find(g => (g.subject || '').toLowerCase() === groupName.toLowerCase())
  return found?.id || null
}

router.post('/:session/send_group', async (req, res) => {
  const { session } = req.params
  const { groupJid, groupName, ...payload } = req.body || {}
  if (!groupJid && !groupName) return res.status(400).json({ ok: false, error: "Informe 'groupJid' ou 'groupName'" })
  try {
    const sock = await getSocket(session)
    const gjid = await resolveGroupJid(sock, { groupJid, groupName })
    if (!gjid) return res.status(404).json({ ok: false, error: 'Grupo não encontrado (informe groupJid ou groupName igual ao título)' })
    const m = await sock.sendMessage(gjid, payload)
    await markBotMessage(session, m.key.id)
    res.json({ ok: true, messageId: m.key.id, groupJid: gjid })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) })
  }
})

router.get('/:session/read/:messageId', async (req, res) => {
  const { session, messageId } = req.params
  try {
    const row = await getMsg(messageId, session)
    if (!row) return res.status(404).json({ ok: false, error: 'Mensagem não encontrada ou sem recibos ainda' })
    const tsOut = (ts) => ts ? new Date(ts * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : null
    res.json({
      ok: true,
      session,
      messageId: row.id,
      to: row.remoteJid,
      status: row.status,
      sent_at: tsOut(row.ts),
      delivered_at: tsOut(row.deliveredAt),
      read_at: tsOut(row.readAt)
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) })
  }
})

router.post('/:session/logout', (req, res) => {
  const { session } = req.params
  logoutSession(session)
  res.json({ ok: true, session })
})

router.get('/', (_, res) => res.json({ ok: true, service: 'baileys-bot' }))

export default router
