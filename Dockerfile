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

# Create a non-root user with a pinned UID/GID.
#
# The UID is pinned because it is the number the bind-mount ownership advice in
# README.md, docs/deployment.md and docs/operations.md tells an operator to chown
# ./data to. Left unpinned, `adduser --system` allocates the lowest free UID in
# Debian's system range (100-999), which moves whenever the base image adds a
# system user — so any number written in the docs would be a guess with a shelf
# life. 10001 is outside both the system range and UID 1000, which the official
# node images already use for the `node` user.
#
# `useradd` prints "uid 10001 is greater than SYS_UID_MAX 999" here. That is a
# cosmetic warning, not an error: adduser still exits 0 and the account is created
# with exactly this UID. Do not "fix" it by dropping --uid; the pinned number is
# the point.
RUN addgroup --system --gid 10001 snapgut \
 && adduser --system --uid 10001 --ingroup snapgut snapgut

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
