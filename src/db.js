import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pg

export const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'whatsapp',
  port: Number(process.env.PGPORT) || 5432,
  max: 10,
  idleTimeoutMillis: 30000,
})

// Testa conexão ao iniciar
pool.connect()
  .then(client => {
    console.log('✅ Conectado ao PostgreSQL com sucesso!')
    client.release()
  })
  .catch(err => {
    console.error('❌ Erro ao conectar ao PostgreSQL:', err)
  })

// ======================================
// Criação de tabelas se não existirem
// ======================================

const createTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      "remoteJid" TEXT NOT NULL,
      "fromMe" INTEGER NOT NULL,
      ts BIGINT NOT NULL,
      status TEXT DEFAULT 'sent',
      "deliveredAt" BIGINT,
      "readAt" BIGINT
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_webhooks (
      session TEXT PRIMARY KEY,
      url TEXT NOT NULL
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sent_bot_ids (
      session TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      ts BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      PRIMARY KEY (session, msg_id)
    )    
  `)
}

createTables().catch(err => {
  console.error('❌ Erro ao criar tabelas:', err)
})

// ======================================
// Funções utilitárias equivalentes ao SQLite
// ======================================

export async function upsertMsg(data) {
  const {
    id,
    session,
    remoteJid,
    fromMe,
    ts,
    status,
    deliveredAt,
    readAt
  } = data

  const query = `
    INSERT INTO whatsapp_messages (id, session, "remoteJid", "fromMe", ts, status, "deliveredAt", "readAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      "deliveredAt" = COALESCE(EXCLUDED."deliveredAt", whatsapp_messages."deliveredAt"),
      "readAt" = COALESCE(EXCLUDED."readAt", whatsapp_messages."readAt")
  `

  const values = [id, session, remoteJid, fromMe, ts, status, deliveredAt, readAt]
  await pool.query(query, values)
}

export async function getMsg(id, session) {
  const { rows } = await pool.query(
    'SELECT * FROM whatsapp_messages WHERE id = $1 AND session = $2',
    [id, session]
  )
  return rows[0] || null
}

export async function setWebhook(session, url) {
  await pool.query(
    `INSERT INTO whatsapp_webhooks (session, url) VALUES ($1, $2)
     ON CONFLICT (session) DO UPDATE SET url = EXCLUDED.url`,
    [session, url]
  )
}

export async function getWebhook(session) {
  const { rows } = await pool.query(
    'SELECT url FROM whatsapp_webhooks WHERE session = $1',
    [session]
  )
  return rows[0] || null
}

export async function markBotMessage(session, msgId) {
  await pool.query(
    `INSERT INTO whatsapp_sent_bot_ids (session, msg_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [session, msgId]
  )
}

export async function wasBotMessage(session, msgId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM whatsapp_sent_bot_ids
     WHERE session = $1 AND msg_id = $2
     LIMIT 1`,
    [session, msgId]
  )
  return rows.length > 0
}

export async function cleanupBotMessageIds(days = 7) {
  await pool.query(
    `DELETE FROM whatsapp_sent_bot_ids
     WHERE ts < (EXTRACT(EPOCH FROM NOW())::BIGINT - $1 * 86400)`,
    [days]
  )
}

export default pool