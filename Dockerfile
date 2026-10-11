# Debian-based slim image (not Alpine) so native modules such as bcrypt install cleanly.
FROM node:24-slim

WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app ./app
COPY db ./db
COPY scripts ./scripts
COPY knexfile.js ./

USER node
EXPOSE 3000

# Run pending migrations, then start the server.
CMD ["sh", "-c", "npx knex migrate:latest --knexfile knexfile.js && exec node app/src/server.js"]
