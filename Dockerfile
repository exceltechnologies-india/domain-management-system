FROM node:20-alpine AS base

# ── deps stage ────────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ── builder stage ─────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* variables are baked into the client bundle at build time.
# Pass them with --build-arg in your CI pipeline or Cloud Build trigger.
ARG NEXT_PUBLIC_RAZORPAY_KEY_ID
ENV NEXT_PUBLIC_RAZORPAY_KEY_ID=$NEXT_PUBLIC_RAZORPAY_KEY_ID

ARG NEXT_PUBLIC_SUPPORT_EMAIL=support@anutech.in
ENV NEXT_PUBLIC_SUPPORT_EMAIL=$NEXT_PUBLIC_SUPPORT_EMAIL

# All other environment variables (secrets, DB URIs, API keys) are NOT baked
# into the image. They are injected at runtime by Cloud Run via Secret Manager
# or the Cloud Run service environment-variable configuration.

RUN npm run build

# ── runner stage ──────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

RUN mkdir .next && chown nextjs:nodejs .next

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# Cloud Run injects PORT at runtime (default 8080).
# We set 8080 here so local `docker run` works without extra flags too.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

EXPOSE 8080

CMD ["node", "server.js"]
