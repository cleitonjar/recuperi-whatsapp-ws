import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys'
import fs from 'fs'
import path from 'path'
import qrcode from 'qrcode'
import { isBoom } from '@hapi/boom'
import { upsertMsg, getMsg, wasBotMessage } from './db.js'
import { postWebhook } from './webhook.js'

const sessions = new Map()
const qrStore = new Map()
const statusStore = new Map()

export function toJid(input) {
  const digits = String(input || '').replace(/\D/g, '')
  if (!digits) throw new Error('Número inválido')
  return `${digits}@s.whatsapp.net`
}

export function tsToOut(ts) {
  if (!ts) return null
  const d = new Date(ts * 1000)
  return {
    epoch: ts,
    iso: d.toISOString(),
    br: d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  }
}

export async function getSocket(session) {
  if (sessions.has(session)) return sessions.get(session)

  const baseDir = path.resolve('./sessions', session)
  fs.mkdirSync(baseDir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(baseDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: true,
    markOnlineOnConnect: false,
    browser: Browsers.macOS('Safari'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  })

  sessions.set(session, sock)
  statusStore.set(session, { connection: 'starting', lastChange: Date.now() })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrStore.set(session, qr)
    }

    if (connection) {
      statusStore.set(session, { connection, lastChange: Date.now() })

      if (connection === 'open') {
        console.log(`[${session}] ✅ Conexão aberta — sincronizando recibos pendentes...`)
        try {
          await sock.fetchStatus() // opcional — atualiza status de presença
        } catch (err) {
          console.error(`[${session}] Erro ao sincronizar recibos:`, err)
        }
      }

      if (connection === 'close') {
        // 🔍 Captura o motivo real da desconexão
        const err = lastDisconnect?.error
        const reason =
          err?.output?.statusCode || err?.message || err?.stack || 'Motivo desconhecido'

        console.error(`❌ [${session}] Conexão encerrada — motivo:`, reason)

        // ⚠️ Log especial para QR expirado
        if (String(reason).includes('QR refs attempts ended')) {
          console.warn(`⚠️ [${session}] QR expirou ou não foi escaneado a tempo.`)
        }

        // �� Reconnect lógico padrão
        const shouldReconnect =
          err && isBoom(err) && err.output.statusCode !== 401

        sessions.delete(session)

        if (shouldReconnect) {
          console.log(`�� [${session}] Tentando reconectar em 1.5s...`)
          setTimeout(() => getSocket(session), 1500)
        }
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`\n🟢 EVENTO: messages.upsert (${type}) - ${messages?.length || 0} msg(s)`)
    console.log('messages.upsert:', JSON.stringify(messages ?? [], null, 2))
    const m = messages?.[0]
    if (!m) return

    try {
      const ts = Number(m.messageTimestamp || Math.floor(Date.now() / 1000))
      const msgId = String(m.key?.id || '')
      const remoteJid = String(m.key?.remoteJid || '')

      if (!m.key?.fromMe) {
        // 📥 Mensagem recebida → dispara webhook
        /*const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          null

        console.log(`📩 [${session}] Msg recebida de ${remoteJid}:`, text)*/

        // comentado para quando ler respostas
        /*await postWebhook(session, {
          type: 'message',
          session,
          from: remoteJid,
          id: msgId,
          text,
          timestamp: tsToOut(ts)
        })*/
      } else {
        const isBotMsg = await wasBotMessage(session, msgId)
        if (!isBotMsg) {
          // 🛑 Ignora mensagens enviadas manualmente no WhatsApp Web
          return
        }

        // 📤 Mensagem enviada → salva no banco
        await upsertMsg({
          id: msgId,
          session: String(session),
          remoteJid: remoteJid,
          fromMe: 1,
          ts: ts,
          status: 'sent',
          deliveredAt: null,
          readAt: null
        })

	postWebhook(session, {
          profileId: session,
          messageId: msgId,
          phone: remoteJid,
          status: "SENT",
          type: "ReceivedCallback",
          deliveredAt: null,
          readAt: null
        })

      }
    } catch (err) {
      console.error('❌ Erro no messages.upsert:', err, messages)
    }
  })

  sock.ev.on('messages.update', async (updates) => {
    console.log(`\n🟡 EVENTO: messages.update - ${updates?.length || 0} update(s)`)
    console.log('messages.update:', JSON.stringify(updates ?? [], null, 2))
    try {
      for (const u of updates) {

        try {
          const msgId = u?.key?.id
          const remoteJid = u?.key?.remoteJid || ''
          const fromMe = u?.key?.fromMe ? 1 : 0

          if (!msgId) continue

          const isBotMsg = await wasBotMessage(session, msgId)
          if (!isBotMsg) continue

          const s = u.update?.status
          const ts = u.update?.receiptTimestamp || u.update?.messageTimestamp || Math.floor(Date.now() / 1000)

          // Busca os valores atuais para preservar deliveredAt/readAt já salvos
          const row = await getMsg(msgId, session) || {}
          const currentDelivered = row.deliveredAt || null
          const currentRead = row.readAt || null

          if (s === 1) {
            await upsertMsg({
              id: msgId,
              session,
              remoteJid,
              fromMe,
              ts,
              status: 'sent',
              deliveredAt: currentDelivered,
              readAt: currentRead
            })
            postWebhook(session, {
              profileId: session,
              messageId: msgId,
              phone: remoteJid,
              status: "SENT",
              type: "ReceivedCallback",
              deliveredAt: currentDelivered ? tsToOut(currentDelivered) : null,
              readAt: currentRead ? tsToOut(currentRead) : null
            })

          } else if (s === 2 || s === 'DELIVERY_ACK') {

            // ✅ Delivered — pode vir múltiplas vezes (vários devices)
            if (currentDelivered) {
              console.log(`[${session}] ℹ️ Delivered duplicado ignorado para ${msgId}`)
              continue
            }

            await upsertMsg({
              id: msgId,
              session,
              remoteJid,
              fromMe,
              ts,
              status: 'delivered',
              deliveredAt: currentDelivered || ts, // preserva se já existia
              readAt: currentRead // mantém se já tinha sido lido
            })
            postWebhook(session, {
              profileId: session,
              messageId: msgId,
              phone: remoteJid,
              status: "DELIVERED",
              type: "ReceivedCallback",
              deliveredAt: tsToOut(currentDelivered || ts),
              readAt: currentRead ? tsToOut(currentRead) : null
            })

          } else if (s === 3 || s === 'PLAYED') {

            // 🔊 Played (áudio) — tratar opcionalmente
            console.log(`[${session}] ▶️ Recebido status=3 (played) para ${msgId}`)

          } else if (s === 4) {

            // 🟦 Read — também pode vir repetido em múltiplos devices
            if (currentRead) {
              console.log(`[${session}] ℹ️ Read duplicado ignorado para ${msgId}`)
              continue
            }

            // ✅ Read
            await upsertMsg({
              id: msgId,
              session,
              remoteJid,
              fromMe,
              ts,
              status: 'read',
              deliveredAt: currentDelivered, // mantém entrega anterior
              readAt: currentRead ? currentRead : ts // não sobrescreve se já tinha lido antes
            })
            postWebhook(session, {
              profileId: session,
              messageId: msgId,
              phone: remoteJid,
              status: "READ",
              type: "ReceivedCallback",
              deliveredAt: currentDelivered ? tsToOut(currentDelivered) : null,
              readAt: tsToOut(currentRead || ts)
            })
          }

        } catch (innerErr) {
          console.error('[messages.update] Falha ao processar update individual:', u, innerErr)
        }
      }
    } catch (err) {
      console.error('[messages.update] Erro inesperado no loop:', err)
    }
  })  

  sock.ev.on('message-receipt.update', async (updates) => {
    console.log(`\n🔵 EVENTO: message-receipt.update - ${updates?.length || 0} receipt(s)`)
    console.log('message-receipt.update:', JSON.stringify(updates ?? [], null, 2))
    try {
      for (const u of updates) {
        const msgId = u?.key?.id
        if (!msgId) continue

        const remoteJid = u?.key?.remoteJid || ''
        const fromMe = u?.key?.fromMe ? 1 : 0
        const status = (u.status || '').toLowerCase()
        const ts = u.receiptTimestamp || Math.floor(Date.now() / 1000)

        const isBotMsg = await wasBotMessage(session, msgId)
        if (!isBotMsg) continue

        // Busca estado atual para não sobrescrever
        const row = await getMsg(msgId, session) || {}
        const currentDelivered = row.deliveredAt || null
        const currentRead = row.readAt || null

        // 1️⃣ Delivered
        if (status === 'delivered' || status === 'delivery') {
          if (currentDelivered) continue // já registrado
          await upsertMsg({
            id: msgId,
            session,
            remoteJid,
            fromMe,
            ts,
            status: 'delivered',
            deliveredAt: ts,
            readAt: currentRead
        })

          postWebhook(session, {
            profileId: session,
            messageId: msgId,
            phone: remoteJid,
            status: "DELIVERED",
            type: "ReceivedCallback",
            deliveredAt: tsToOut(ts),
            readAt: currentRead ? tsToOut(currentRead) : null
          })
        }

        // 2️⃣ Read ou Played (check azul ou áudio escutado)
        if (status === 'read' || status === 'played') {
          if (currentRead) continue // já registrado
          await upsertMsg({
            id: msgId,
            session,
            remoteJid,
            fromMe,
            ts,
            status: 'read',
            deliveredAt: currentDelivered || ts,
            readAt: ts
          })

          postWebhook(session, {
            profileId: session,
            messageId: msgId,
            phone: remoteJid,
            status: "READ",
            type: "ReceivedCallback",
            deliveredAt: currentDelivered ? tsToOut(currentDelivered) : tsToOut(ts),
            readAt: tsToOut(ts)
          })
        }
      }
    } catch (err) {
      console.error('[message-receipt.update] erro:', err)
    }
  })

  return sock
}

export function getStatus(session) {
  return statusStore.get(session) || { connection: 'unknown' }
}

export function getLastQr(session) {
  return qrStore.get(session) || null
}

export async function getQrPng(session) {
  const qr = getLastQr(session)
  if (!qr) return null
  return await qrcode.toBuffer(qr, { width: 300 })
}

export function logoutSession(session) {
  const dir = path.resolve('./sessions', session)
  sessions.delete(session)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}
