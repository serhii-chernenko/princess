FROM node:24-bookworm-slim

RUN mkdir -p /princess/bot
WORKDIR /princess

COPY ./package.json ./
COPY ./package-lock.json ./
COPY ./releases.generated.json ./
COPY ./bot ./bot/

RUN npm ci

CMD ["npm", "run", "dev"]
