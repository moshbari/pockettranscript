# Get Transcript server + its own transcriber (needs ffmpeg + yt-dlp).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg curl ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp && yt-dlp --version \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["sh", "-c", "(yt-dlp -U || true) && node server.js"]
