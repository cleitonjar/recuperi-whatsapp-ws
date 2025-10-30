import express from 'express'
import cors from 'cors'
import pino from 'pino'
import routes from './routes.js'
import { cleanupBotMessageIds } from './db.js'
import fs from 'fs'
import path from 'path'
import { getSocket } from './baileys.js'

const LOG_PRETTY = process.env.LOG_PRETTY === 'true'
const logger = pino(LOG_PRETTY ? pino.transport({ target: 'pino-pretty', options: { colorize: true } }) : undefined)

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.use(routes)

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => logger.info(`Baileys BOT listening on :${PORT}`))

// === Conexão automática ===
const baseSessionsDir = path.resolve('./sessions')
if (fs.existsSync(baseSessionsDir)) {
  const dirs = fs.readdirSync(baseSessionsDir)
  for (const session of dirs) {
    const fullPath = path.join(baseSessionsDir, session)
    if (fs.statSync(fullPath).isDirectory()) {
      logger.info(`🔌 Iniciando sessão automática: ${session}`)
      getSocket(session).catch(err =>
        logger.error(`❌ Erro ao iniciar sessão ${session}:`, err)
      )
    }
  }
}

// limpa a cada 6 horas mensagens mais antigas que 7 dias
setInterval(() => {
  cleanupBotMessageIds(7).catch(console.error)
}, 6 * 60 * 60 * 1000)