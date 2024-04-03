FROM node:20

WORKDIR /app

COPY package.json /app/package.json

RUN cd /app && npm install --production

EXPOSE 1000
EXPOSE 1001
EXPOSE 3001

