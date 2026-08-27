# --- build stage: build the PWA ---
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- run stage: serve dist + api ---
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

# Create a non-root user
RUN addgroup --system snapgut && adduser --system --ingroup snapgut snapgut

# Create and own the data directory
RUN mkdir -p /data && chown snapgut:snapgut /data

COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist

USER snapgut
EXPOSE 8080
CMD ["node", "server/main.js"]
