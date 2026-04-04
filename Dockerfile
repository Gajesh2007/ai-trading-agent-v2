FROM node:22-slim

# Python for runSimulation tool
RUN apt-get update && apt-get install -y python3 python3-pip grep && \
    pip3 install --break-system-packages numpy pandas scipy && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN npm install --production=false

COPY . .

# Create workspace and logs dirs (will be overridden by volume mounts)
RUN mkdir -p workspace/state/signal-cache workspace/config logs

CMD ["npx", "tsx", "src/main.ts"]
