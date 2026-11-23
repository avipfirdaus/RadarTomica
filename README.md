# Radar Tomica Jepang

Sistem radar yang memantau rilis Tomica di Jepang dan harga pasar Indonesia, menghitung kelayakan PO, lalu menyiapkan draf postingan Telegram yang **baru terkirim ke channel publik setelah disetujui operator**.

- Spesifikasi acuan: [docs/PRD.md](docs/PRD.md)
- Arsitektur & kontrak modul: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Daftar periksa privasi faceless channel: [src/telegram/CHANNEL_CHECKLIST.md](src/telegram/CHANNEL_CHECKLIST.md)

## Modul yang Tersedia (Fase 0 + Fase 1)

| Modul | Folder | Ringkasan |
| --- | --- | --- |
| F1 Ingest & Jadwal | `src/ingest/`, `src/scheduler/` | Pengambilan HTML/PDF/RSS dengan `robots.txt`, jeda ≥5 detik/host, dedup `content_hash`, jeda otomatis setelah 2 gagal berturut-turut, 9 jadwal `Asia/Tokyo` |
| F2 Ekstraksi & F5 Klasifikasi | `src/extract/`, `src/classify/` | Prompt berversi `P1@1`/`P2@1`/`P3@1` + glosarium `G@1`, batas anggaran bulanan LLM, verifikasi kutipan bukti dalam kode, deteksi prompt injection, skrip evaluasi 20 fixture |
| F3/F4 Domain, F6 Harga, F7 Kalender | `src/domain/`, `src/pricing/`, `src/calendar/` | Normalisasi & dedup item, deteksi perubahan, aturan kualitas data (P1 atau 2×P2), rumus Landed/HargaPO/AcuanLangka + 1,5×IQR, kurs Frankfurter, Sabtu ketiga JST |
| F8 Peringatan, F9 Draf, Bot Operator | `src/telegram/`, `src/notify/`, `src/drafts/` | Bot Telegram khusus operator (`/status`, `/jeda`, `/lanjut`, `/abaikan`, `/ambang`, `/ambilulang`, `/log`, `/review`), ringkasan harian & mingguan, gerbang Setuju/Edit/Tolak dengan hitung ulang data > 24 jam |
| Orkestrasi Pipeline | `src/pipeline/`, `src/main.ts` | Integrasi end-to-end F1→F9 + kontrol operator |

## Menjalankan Lokal & Pengujian

```bash
npm install
npm test              # jalankan semua unit & E2E test (in-memory PGlite, tanpa jaringan)
npm run typecheck     # tsc --noEmit
npm run build         # kompilasi ke dist/
```

Evaluasi set uji 20 teks + 1 halaman prompt injection:

```bash
LLM_MOCK=1 npx tsx src/extract/eval.ts   # mode mock
# Atau dengan kunci asli:
# ANTHROPIC_API_KEY=sk-ant-... npx tsx src/extract/eval.ts
```

## Menjalankan dengan Docker

```bash
cp .env.example .env
# Isi ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_OPERATOR_CHAT_ID, TELEGRAM_CHANNEL_ID
# Set LLM_MOCK=0 dan TELEGRAM_DRY_RUN=0 bila siap operasional
docker compose up -d --build
```
