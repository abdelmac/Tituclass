FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY server.js ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/medclass.sqlite
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]
