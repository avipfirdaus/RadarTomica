# Panduan Deploy di Google Cloud Platform (GCP)

Panduan ringkas menjalankan **Radar Tomica Jepang** 24/7 di **GCP Compute Engine** memakai Docker Compose (Node 22 + Postgres 16).

---

## 1. Pilih Konfigurasi VM (Hindari Tagihan Tak Terduga)

| Mode | Region | Machine Type | Boot Disk | Perkiraan Biaya |
| --- | --- | --- | --- | --- |
| **Always Free (\$0)** | **`us-west1` (Oregon)** *(terdekat ke Jepang)* | `e2-micro` (2 vCPU shared, 1 GB RAM) | **30 GB Standard (`pd-standard`)** | **\$0/bulan** |
| **Kredit Trial \$300 / IP Jepang** | **`asia-northeast2` (Osaka)** atau `asia-northeast1` (Tokyo) | `e2-small` (2 GB RAM) | 20–30 GB `pd-standard` | ~\$16/bln (dipotong dari kredit trial) |

> **Aturan penting Always Free GCP:**
> - Hanya berlaku di `us-west1`, `us-central1`, dan `us-east1` (**bukan** Osaka/Tokyo).
> - Wajib pilih **Standard Persistent Disk (`pd-standard`)** ≤ 30 GB (bukan `pd-balanced`).
> - Di tab *Networking → Network Service Tier*, pilih **Standard** (bukan Premium).
> - **Firewall:** biarkan *Allow HTTP traffic* dan *Allow HTTPS traffic* **tidak dicentang** (bot Telegram memakai *long polling* keluar, tidak perlu port terbuka).
> - Pasang **Billing Budget Alert** di *Billing → Budgets & alerts* (mis. ambang \$1, \$5, \$10).

---

## 2. Buat VM & Jalankan Skrip Setup

1. Di GCP Console → **Compute Engine → VM Instances → Create Instance**:
   - **Boot disk:** Ubuntu **24.04 LTS** (x86/64), **30 GB Standard Persistent Disk**
   - Klik **Create**, tunggu hingga status hijau, lalu klik tombol **SSH**.
2. Di terminal SSH VM, jalankan setup otomatis (membuat swap 2 GB, install Docker + Compose, clone repo, menyiapkan `.env`, dan memasang cron backup Postgres harian):

```bash
curl -fsSL https://raw.githubusercontent.com/avipfirdaus/RadarTomica/main/scripts/setup-gcp-vm.sh | bash
```

*(Atau setelah clone manual: `bash ~/RadarTomica/scripts/setup-gcp-vm.sh`.)*

3. Jika Docker baru saja terpasang, aktifkan grup docker pada sesi saat ini:
```bash
newgrp docker
```

---

## 3. Isi `.env` & Uji Staging

Edit `~/RadarTomica/.env` (izin file sudah otomatis `chmod 600`):
```bash
nano ~/RadarTomica/.env
```

Isi minimal:
- **LLM (pilih salah satu):**
  - **Claude (Anthropic):** `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...`, `LLM_MODEL=claude-sonnet-4-5`
  - **OpenRouter gratis (Qwen):** `LLM_PROVIDER=openai_compat`, `LLM_BASE_URL=https://openrouter.ai/api/v1`, `LLM_API_KEY=...`, `LLM_MODEL=qwen/qwen3-8b:free`
  - **Google Gemini gratis:** `LLM_PROVIDER=openai_compat`, `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `LLM_API_KEY=...`, `LLM_MODEL=gemini-2.5-flash`
- **Telegram (mulai dengan channel privat staging dulu):**
  - `TELEGRAM_BOT_TOKEN=...`
  - `TELEGRAM_OPERATOR_CHAT_ID=...` (ID chat pribadi kamu)
  - `TELEGRAM_CHANNEL_ID=...` (ID channel privat uji, bot hanya diberi hak **Post Messages**)
- Set `LLM_MOCK=0` dan `TELEGRAM_DRY_RUN=0`.

Jalankan layanan & verifikasi:
```bash
cd ~/RadarTomica
docker compose up -d --build
docker compose exec radar npm run smoke-test -- --live
docker compose logs -f radar
```

Uji dari chat pribadi Telegram ke bot:
- `/status`, `/ringkasan`, `/testdraf` (uji tombol **Setuju / Edit / Tolak** ke channel privat uji), `/ambilulang takaratomy-lineup`, `/log`.
- Biarkan berjalan **5 hari berturut-turut** (syarat lulus Fase 0 di [PRD.md](./PRD.md)).

---

## 4. Go-Live ke Channel Publik

1. Selesaikan semua poin privasi faceless di [src/telegram/CHANNEL_CHECKLIST.md](../src/telegram/CHANNEL_CHECKLIST.md).
2. Ganti `TELEGRAM_CHANNEL_ID` di `~/RadarTomica/.env` ke channel publik **Radar Tomica Jepang**.
3. Restart container:
```bash
cd ~/RadarTomica && docker compose up -d
```

---

## 5. Update & Backup / Restore Harian

**Update ke versi terbaru `main`:**
```bash
cd ~/RadarTomica && git pull origin main && docker compose up -d --build
```

**Backup manual** (otomatis jalan tiap hari `03:15 JST` via cron, tersimpan di `~/RadarTomica/backups/` dengan retensi 14 hari):
```bash
~/RadarTomica/scripts/backup-db.sh
```

**Restore dari file backup:**
```bash
cd ~/RadarTomica
gunzip -c backups/radar-YYYYMMDD-HHMMSSZ.sql.gz | docker compose exec -T db psql -U radar -d radar
```
