#!/usr/bin/env bash
# One-time server setup for SharedMarkdown. Run on the server as the deploy user (studue):
#   sudo bash setup-server.sh
# Safe to run again: existing users, files and the admin password are kept.
set -euo pipefail

DEPLOY_USER=studue          # the user GitHub Actions deploys as (scp + restart)
APP_USER=sharedmarkdown     # the user the app runs as (owns the data)
ROOT=/opt/sharedmarkdown
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

echo "== App user"
id "$APP_USER" &>/dev/null || useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin "$APP_USER"

echo "== Folders"
# releases: written by the deploy user, readable by the app
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$ROOT" "$ROOT/releases"
# data: database, backups, keys; only the app user can read it
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$ROOT/data"

echo "== Secrets"
ENV_FILE="$ROOT/sharedmarkdown.env"
if [ ! -f "$ENV_FILE" ]; then
  PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-28)
  printf 'Admin__Password=%s\n' "$PASSWORD" > "$ENV_FILE"
  NEW_PASSWORD=$PASSWORD
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "== systemd unit"
install -m 644 "$HERE/sharedmarkdown.service" /etc/systemd/system/sharedmarkdown.service
systemctl daemon-reload
systemctl enable sharedmarkdown >/dev/null

echo "== sudo rule so deploys can restart the service without a password"
SUDOERS=/etc/sudoers.d/sharedmarkdown
TMP=$(mktemp)
cat > "$TMP" <<RULE
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart sharedmarkdown, /usr/bin/systemctl start sharedmarkdown, /usr/bin/systemctl stop sharedmarkdown, /usr/bin/systemctl status sharedmarkdown, /bin/systemctl restart sharedmarkdown
RULE
visudo -cf "$TMP" >/dev/null   # refuse to install a broken sudoers file
install -m 440 "$TMP" "$SUDOERS"
rm -f "$TMP"

echo "== Caddy"
CADDYFILE=/etc/caddy/Caddyfile
if grep -q '^sharedmarkdown.com' "$CADDYFILE"; then
  echo "Caddyfile already has a sharedmarkdown.com block, leaving it alone."
else
  cp -p "$CADDYFILE" "$CADDYFILE.before-sharedmarkdown"
  { echo; cat "$HERE/Caddyfile"; } >> "$CADDYFILE"
  if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
    echo "Caddy reloaded (previous config saved as Caddyfile.before-sharedmarkdown)."
  else
    cp -p "$CADDYFILE.before-sharedmarkdown" "$CADDYFILE"
    echo "Caddy config didn't validate, restored the previous Caddyfile:"
    caddy validate --config "$CADDYFILE" --adapter caddyfile || true
    exit 1
  fi
fi

echo
echo "Done. The service starts with the first deploy (it has nothing to run yet)."
if [ -n "${NEW_PASSWORD:-}" ]; then
  echo
  echo "Admin password for https://sharedmarkdown.com/admin (shown once, stored in $ENV_FILE):"
  echo "  $NEW_PASSWORD"
fi
