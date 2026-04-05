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

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy built dist
COPY dist/ ./dist/

# Download whisper base model
RUN mkdir -p models && \
    curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -o models/ggml-base.bin

# Expose HTTP port
EXPOSE 3100

# Run in HTTP mode
CMD ["node", "dist/index.js", "--http", "--port=3100"]
