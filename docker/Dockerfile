# EchoAnswer — 零依赖 Node.js 服务（Node 24 内置 node:sqlite）
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# 无 npm 依赖：直接拷贝运行文件（前端构建产物 web/dist 随仓库提交，部署不跑构建；P7 起站点根 = web/dist）
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY web/dist ./web/dist

# 会话数据目录（建议挂载卷持久化）
VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "--no-warnings", "server.js"]
