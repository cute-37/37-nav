# 网址导航的容器镜像。项目没有需要编译的原生模块，用 alpine 即可。
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# 容器里端口和数据目录固定：端口靠 docker 的 -p 映射来改，数据放在挂载的 /data 里
ENV NODE_ENV=production PORT=3080 HOST=0.0.0.0 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- --header='X-Nav: 1' http://127.0.0.1:3080/api/state >/dev/null || exit 1

CMD ["node", "server/index.js"]
