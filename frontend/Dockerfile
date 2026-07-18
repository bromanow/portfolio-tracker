# ── Stage 1: build the Vite app ──────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# VITE_API_BASE_URL is baked in at build time (Vite inlines import.meta.env.*)
# Coolify must pass this as a BUILD-time variable.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: serve the static build with nginx ───────────────────────────────
FROM nginx:alpine

# SPA routing: fall back to index.html for client-side routes.
# Hashed /assets/* files are safe to cache forever (a new build gets a new hash),
# but index.html itself must never be cached — otherwise browsers (and CDNs) can
# keep serving a stale app shell that references old, no-longer-existing asset
# hashes after a deploy, silently hiding new features until a hard refresh.
RUN printf 'server {\n\
    listen 80;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location /assets/ {\n\
        add_header Cache-Control "public, max-age=31536000, immutable";\n\
    }\n\
    location / {\n\
        add_header Cache-Control "no-cache, no-store, must-revalidate";\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
