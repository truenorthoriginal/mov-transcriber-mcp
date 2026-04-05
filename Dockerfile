FROM node:22-slim

# Install ffmpeg and build tools for whisper-cpp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    cmake \
    g++ \
    make \
    git \
    && rm -rf /var/lib/apt/lists/*

# Build whisper.cpp from source
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /tmp/whisper-cpp && \
    cd /tmp/whisper-cpp && \
    cmake -B build && \
    cmake --build build --config Release -j$(nproc) && \
    cp build/bin/whisper-cli /usr/local/bin/whisper-cli && \
    rm -rf /tmp/whisper-cpp

WORKDIR /app

# Copy package files and install all deps (including devDependencies for build)
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY src/ ./src/
RUN npx tsc

# Remove devDependencies after build
RUN npm prune --production

# Download whisper base model
RUN mkdir -p models && \
    curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -o models/ggml-base.bin

# Render sets PORT env var automatically; fallback to 3100
ENV PORT=3100
EXPOSE 3100

# Server auto-detects PORT env and starts in HTTP mode
CMD ["node", "dist/index.js"]
