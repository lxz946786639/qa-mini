# QA Mini https sidecar：nginx + openssl（自签证书自动生成需要 openssl CLI，
# 官方 nginx:alpine 镜像不带该命令，故在此补充构建；nginx.conf 仍走卷挂载，改配置无需重建）
FROM nginx:alpine
RUN apk add --no-cache openssl
COPY tls/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
