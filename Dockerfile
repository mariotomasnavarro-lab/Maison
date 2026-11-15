FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./server.js
COPY public ./public
EXPOSE 3000
CMD ["node","server.js"]
