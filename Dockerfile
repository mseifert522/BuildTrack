# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS production
RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app/backend

# Install backend dependencies
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3 --build-from-source

# Copy backend source
COPY backend/ ./

# Copy built frontend to path server.js expects (../frontend/dist)
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

# Create data and uploads directories
RUN mkdir -p data uploads

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=./data/buildtrack.db
ENV UPLOADS_PATH=./uploads

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "server.js"]
