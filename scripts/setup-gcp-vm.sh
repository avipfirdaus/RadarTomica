#!/usr/bin/env bash
# Setup otomatis VM Ubuntu 24.04 di GCP Compute Engine (e2-micro / e2-small)
# untuk Radar Tomica Jepang:
#   1. Buat swap 2 GB (penting untuk e2-micro 1 GB RAM)
#   2. Install Docker Engine + Docker Compose plugin
#   3. Clone / perbarui repo avipfirdaus/RadarTomica
#   4. Siapkan .env dari .env.example (chmod 600)
#   5. Pasang cron backup Postgres harian (03:15 JST / 18:15 UTC)
#
# Idempoten: aman dijalankan ulang.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/avipfirdaus/RadarTomica.git}"
APP_DIR="${APP_DIR:-$HOME/RadarTomica}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

echo "=== [1/5] Memeriksa swap ($SWAP_SIZE) ==="
if ! swapon --show | grep -q '/swapfile'; then
  if [ ! -f /swapfile ]; then
    sudo fallocate -l "$SWAP_SIZE" /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
  fi
  sudo swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
  sudo sysctl -w vm.swappiness=20 >/dev/null
  echo 'vm.swappiness=20' | sudo tee /etc/sysctl.d/99-radar-swap.conf >/dev/null
  echo "Swap $SWAP_SIZE aktif."
else
  echo "Swap sudah aktif, dilewati."
fi

echo "=== [2/5] Memeriksa Docker & Docker Compose ==="
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg git
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  # shellcheck disable=SC1091
  . /etc/os-release
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo "Docker terpasang."
else
  echo "Docker sudah terpasang: $(docker --version)"
fi

echo "=== [3/5] Mengambil repositori RadarTomica ==="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only origin main
else
  git clone "$REPO_URL" "$APP_DIR"
fi
chmod +x "$APP_DIR/scripts/backup-db.sh" "$APP_DIR/scripts/setup-gcp-vm.sh"

echo "=== [4/5] Menyiapkan .env ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "File $APP_DIR/.env dibuat dari .env.example (mode 600)."
else
  chmod 600 "$APP_DIR/.env"
  echo "File $APP_DIR/.env sudah ada, tidak ditimpa."
fi

echo "=== [5/5] Memasang cron backup Postgres harian (03:15 JST / 18:15 UTC) ==="
CRON_LINE="15 18 * * * APP_DIR=$APP_DIR $APP_DIR/scripts/backup-db.sh >> $APP_DIR/backups/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'scripts/backup-db.sh' || true; echo "$CRON_LINE" ) | crontab -
echo "Cron backup terpasang."

cat <<EOF

====================================================================
Setup VM GCP selesai! Langkah selanjutnya:

1. Jika Docker baru saja dipasang, login ulang atau jalankan:
   newgrp docker

2. Isi kredensial di .env:
   nano $APP_DIR/.env
   (Isi LLM_PROVIDER / API key, TELEGRAM_BOT_TOKEN, TELEGRAM_OPERATOR_CHAT_ID,
    TELEGRAM_CHANNEL_ID staging, lalu set LLM_MOCK=0 dan TELEGRAM_DRY_RUN=0)

3. Jalankan container:
   cd $APP_DIR && docker compose up -d --build

4. Verifikasi koneksi DB, kurs & env:
   docker compose exec radar npm run smoke-test -- --live
   docker compose logs -f radar
====================================================================
EOF
