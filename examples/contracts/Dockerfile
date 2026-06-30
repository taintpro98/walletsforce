FROM node:22-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm install

# Bring in the project and pre-compile (downloads the solc binary at build time).
COPY . .
RUN npx hardhat compile

# Default: run a local chain. The compose `deploy` service overrides this command.
CMD ["npx", "hardhat", "node", "--hostname", "0.0.0.0"]
