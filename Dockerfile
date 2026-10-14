FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
# DATABASE_URL must be set at runtime (see .env.example).
CMD ["node", "server.js"]
