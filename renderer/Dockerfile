FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY src ./src
ENV MEDIA_ROOT=/media OUTPUT_ROOT=/output REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
EXPOSE 3001
CMD ["node", "src/server.mjs"]
