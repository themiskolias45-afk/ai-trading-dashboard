FROM node:20-slim

# Install build tools needed for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy server dependencies and install
COPY server/package*.json ./server/
RUN cd server && npm install --production && npm rebuild better-sqlite3 --build-from-source

# Copy server source
COPY server/ ./server/

# Copy dashboard (static HTML served by the server)
COPY dashboard/ ./dashboard/

# Copy commercial landing page
COPY commercial/ ./commercial/

# Data directory for SQLite volume mount
RUN mkdir -p /data

EXPOSE 3001

CMD ["node", "server/index.js"]
