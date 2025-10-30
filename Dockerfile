# ✅ Etapa única e leve — Baileys + PostgreSQL
FROM node:20-alpine

WORKDIR /app

# 🕓 Timezone + git (para instalar pacotes via repositórios Git)
RUN apk add --no-cache tzdata git \
 && cp /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime \
 && echo "America/Sao_Paulo" > /etc/timezone

# ⚡ Instala apenas dependências de produção
COPY package.json ./
RUN npm install --omit=dev

# 📦 Copia o restante do código
COPY src ./src
COPY .env ./

ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "src/index.js"]