#!/bin/sh
# Generate self-signed TLS certs + DH params for the nginx container.
# For production replace with real Let's Encrypt certs (certbot).

set -eu

DIR="$(dirname "$0")/.."
CERT_DIR="$DIR/nginx/certs"

mkdir -p "$CERT_DIR"

# DH params (used by nginx.conf: ssl_dhparam)
if [ ! -f "$CERT_DIR/dhparam.pem" ]; then
  echo "Generating dhparam.pem (2048-bit)..."
  openssl dhparam -out "$CERT_DIR/dhparam.pem" 2048
fi

# Self-signed certificate
if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
  echo "Generating self-signed certificate..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" \
    -subj "/CN=messenger.local"
fi

echo "TLS assets ready in $CERT_DIR"