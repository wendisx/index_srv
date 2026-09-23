#
# index-srv 镜像：纯 Node 原生实现，无第三方依赖，因此无需安装依赖层。
# 运行期数据统一挂载到 /app/data（对应宿主机的 ./data）。
#
# 不使用 `# syntax=docker/dockerfile:1`：本文件只用经典指令，构建不需要额外特性，
# 去掉后直接使用 Docker 内置的 Dockerfile 前端 —— 构建无需访问 Docker Hub。
FROM node:lts-alpine3.23

ENV NODE_ENV=production \
    INDEX_SRV_ROOT=/app \
    INDEX_SRV_HOST=0.0.0.0 \
    INDEX_SRV_PORT=8080

WORKDIR /app

# 只复制运行所需内容，保持镜像最小化
COPY package.json ./
COPY src ./src

# data 目录结构在镜像内预置，宿主机挂载后直接复用
RUN mkdir -p /app/data/conf /app/data/section /app/data/log \
    && chown -R node:node /app

VOLUME ["/app/data"]

USER node

EXPOSE 8080

# 健康检查使用 Node 内置 fetch，避免引入 curl
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.INDEX_SRV_PORT||8080)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
