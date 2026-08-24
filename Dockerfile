# ─── CorpoPay API — container image ────────────────────────────────────────────
# Alternative to the AWS Lambda/CDK deployment. Runs the ESM source directly via
# tsx (Prisma 7 Rust-free client + @prisma/adapter-pg), so there is no native
# query-engine binary to copy and no tsc→dist build step.
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY src ./src
RUN npx prisma generate

EXPOSE 4000

ENV NODE_ENV=production

# Run pending DB migrations (via DIRECT_URL from prisma.config.ts) then start.
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx src/server.ts"]
