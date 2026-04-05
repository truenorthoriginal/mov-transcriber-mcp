FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    cmake \
    g++ \
    make \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Clone and build whisper.cpp
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /whisper-cpp
WORKDIR /whisper-cpp
RUN cmake -B build -DBUILD_SHARED_LIBS=OFF && \
    cmake --build build --config Release -j$(nproc)

# Build the Node app
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npx tsc
RUN npm prune --production

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy whisper binary from builder
COPY --from=builder /whisper-cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli

WORKDIR /app

# Copy built app from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Download whisper base model
RUN mkdir -p models && \
    curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -o models/ggml-base.bin

ENV PORT=3100
EXPOSE 3100

CMD ["node", "dist/index.js"]
