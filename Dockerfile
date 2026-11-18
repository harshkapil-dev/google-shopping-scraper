FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js source.js job-store.js upstream.js pulldata.scraper.json ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]
