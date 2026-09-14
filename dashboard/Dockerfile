FROM node:22-bookworm-slim
WORKDIR /app/dashboard
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY operations.mjs ./
COPY public ./public
EXPOSE 4000
CMD ["node", "--env-file-if-exists=../.env.prod", "server.mjs"]
