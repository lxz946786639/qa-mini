#!/bin/sh
# EchoAnswer tls sidecar 入口：首次启动自动生成自签证书（如缺失），随后启动 nginx。
# 证书落 /certs（宿主机 data/echoanswer-tls/，随 data/ 一起持久化/备份）；SAN 由 TLS_SAN 控制。
set -e

CERT_DIR=/certs
mkdir -p "$CERT_DIR"

if [ ! -f "$CERT_DIR/echoanswer.crt" ] || [ ! -f "$CERT_DIR/echoanswer.key" ]; then
  echo "[echoanswer-tls] 未发现证书，生成自签证书（10 年，CN=echoanswer）..."
  SAN_LIST="${TLS_SAN:-IP:127.0.0.1,DNS:localhost}"
  # openssl ≥1.1.1 支持 -addext；极老版本回退无 SAN（Chrome 不识别 CN 兜底，仅告警）
  if ! openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout "$CERT_DIR/echoanswer.key" \
      -out "$CERT_DIR/echoanswer.crt" \
      -subj "/CN=echoanswer" \
      -addext "subjectAltName=$SAN_LIST"; then
    echo "[echoanswer-tls] 警告: openssl 不支持 -addext，证书无 SAN（浏览器将拒绝）"
    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout "$CERT_DIR/echoanswer.key" \
      -out "$CERT_DIR/echoanswer.crt" \
      -subj "/CN=echoanswer"
  fi
  chmod 644 "$CERT_DIR/echoanswer.crt" "$CERT_DIR/echoanswer.key"
  echo "[echoanswer-tls] 自签证书已生成（SAN: $SAN_LIST）；改服务器 IP 请改 TLS_SAN 并删除本目录证书后重启"
fi

exec nginx -g 'daemon off;'
