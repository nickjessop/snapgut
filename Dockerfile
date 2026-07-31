# --- build stage: build the PWA ---
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- run stage: serve dist + api ---
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
# The server imports shared/ at runtime (the Plan_Catalog, the Route_Table).
COPY shared ./shared
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "server/index.js"]
