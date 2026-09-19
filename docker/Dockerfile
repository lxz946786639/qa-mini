# QA Mini — 零依赖 Node.js 服务（Node 24 内置 node:sqlite）
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# 无 npm 依赖：直接拷贝运行文件
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# 会话数据目录（建议挂载卷持久化）
VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "--no-warnings", "server.js"]
