FROM node:20-alpine AS base

# ── deps stage ────────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
# .npmrc carries `legacy-peer-deps=true` (next-auth peerOptional conflicts
# with nodemailer ^8). Must be present BEFORE `npm ci` runs.
COPY package.json package-lock.json* .npmrc ./
RUN npm ci

# ── builder stage ─────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* variables are baked into the client bundle at build time.
# Pass them with --build-arg in your CI pipeline or Cloud Build trigger.
# Defaults are intentionally permissive ("false"/empty) so a missing arg
# never silently enables a real-money feature flag.
ARG NEXT_PUBLIC_RAZORPAY_KEY_ID
ENV NEXT_PUBLIC_RAZORPAY_KEY_ID=$NEXT_PUBLIC_RAZORPAY_KEY_ID

ARG NEXT_PUBLIC_SUPPORT_EMAIL=support@anutech.in
ENV NEXT_PUBLIC_SUPPORT_EMAIL=$NEXT_PUBLIC_SUPPORT_EMAIL

ARG NEXT_PUBLIC_RECAPTCHA_SITE_KEY=
ENV NEXT_PUBLIC_RECAPTCHA_SITE_KEY=$NEXT_PUBLIC_RECAPTCHA_SITE_KEY

ARG NEXT_PUBLIC_FACEBOOK_ENABLED=false
ENV NEXT_PUBLIC_FACEBOOK_ENABLED=$NEXT_PUBLIC_FACEBOOK_ENABLED

ARG NEXT_PUBLIC_GITHUB_ENABLED=false
ENV NEXT_PUBLIC_GITHUB_ENABLED=$NEXT_PUBLIC_GITHUB_ENABLED

# All real secrets/DB URIs/API keys are injected at runtime by Cloud Run via
# Secret Manager or the Cloud Run service env-var configuration. The placeholders
# below exist ONLY because several lib/ modules throw at MODULE LOAD when their
# env var is missing, and `next build` evaluates route handlers during
# "Collecting page data" — so the build fails without them, even though no
# code actually USES the value at build time. The placeholders never survive
# into runtime (Cloud Run --set-secrets / --set-env-vars overrides them).
ENV NEXTAUTH_SECRET=build-time-placeholder-not-a-real-secret
ENV JWT_SECRET=build-time-placeholder-not-a-real-secret
ENV MONGODB_URI=mongodb://build-time-placeholder/db
ENV RESELLERCLUB_API_URL=https://build-time-placeholder.invalid
ENV RESELLERCLUB_ID=build-time-placeholder
ENV RESELLERCLUB_SECRET=build-time-placeholder
ENV RAZORPAY_KEY_ID=build-time-placeholder
ENV RAZORPAY_KEY_SECRET=build-time-placeholder
ENV DIRECTADMIN_URL=https://build-time-placeholder.invalid
ENV DIRECTADMIN_ADMIN_USER=build-time-placeholder
ENV DIRECTADMIN_API_KEY=build-time-placeholder
ENV SMTP_HOST=build-time-placeholder
ENV SMTP_PORT=587
ENV SMTP_USER=build-time-placeholder
ENV SMTP_PASS=build-time-placeholder
ENV FROM_EMAIL=build-time-placeholder@invalid
ENV ZOHO_ORG_STATE=build-time-placeholder
ENV GOOGLE_CLIENT_ID=build-time-placeholder
ENV GOOGLE_CLIENT_SECRET=build-time-placeholder

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
