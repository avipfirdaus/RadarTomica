# Panduan Pengujian & Staging — Radar Tomica Jepang

Runbook ringkas 4 tahap untuk memverifikasi kode, akurasi ekstraksi LLM, alur staging Telegram end-to-end, dan checklist penerimaan pra-rilis sebelum channel publik diaktifkan. Acuan spesifikasi: [docs/PRD.md](./PRD.md) (§4, §7, §9, §10, §11).

---

## Tahap 1 — Tes Otomatis Lokal (Tanpa Jaringan / Tanpa API Key)

Jalankan semua pemeriksaan berikut dari root repositori sebelum membuka PR atau menjalankan staging:

```bash
# 1. Pemeriksaan tipe TypeScript
npm run typecheck

# 2. Seluruh unit & integration test (termasuk PGlite, harga, kalender, Telegram)
npm test

# 3. Build produksi (output ke dist/)
npm run build

# 4. Evaluasi skema ekstraksi P1 dalam mode mock (offline)
LLM_MOCK=1 npx tsx src/extract/eval.ts

# 5. Smoke test alur end-to-end lokal (ingest → ekstrak → evaluasi → draf)
npm run smoke-test
```

**Syarat lulus Tahap 1:**
- `typecheck`, `test`, `build`, `eval.ts` (mock), dan `smoke-test` selesai dengan exit code `0`.
- Tidak ada kebocoran rahasia di log atau stdout.

---

## Tahap 2 — Evaluasi LLM Asli (Set Uji 20 Teks)

Verifikasi akurasi ekstraksi P1 terhadap model Claude asli (PRD §7 & §10) setiap kali ada perubahan prompt, skema, glosarium, atau versi model.

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/extract/eval.ts
```

Opsional: gunakan `LLM_MODEL=claude-sonnet-4-5` bila ingin menguji model tertentu.

**Syarat lulus Tahap 2 (PRD §7 & §10):**
- Akurasi field wajib **≥ 95%** pada 20 contoh uji nyata (10 resmi/PDF, 5 media, 5 toko).
- **0 kesalahan angka harga (`price_jpy_tax_incl`)** dan **0 kesalahan tanggal rilis (`release_date_jst`)**.
- Setiap field penting memiliki kutipan bukti yang benar-benar ada di teks sumber; field tidak tertulis diisi `null` (bukan tebakan).
- Kasus prompt injection di set uji tidak mengubah keluaran dan ditandai `needs_review: true`.

---

## Tahap 3 — Tes Staging End-to-End (Docker + Channel Telegram Privat Uji)

### 3.1 Persiapan Lingkungan Staging

1. Buat **channel Telegram privat** khusus uji (jangan pakai channel publik) dan tambahkan bot sebagai admin dengan **hanya izin `Post Messages`**.
2. Salin `.env.example` ke `.env` dan isi kredensial staging:
   - `TELEGRAM_BOT_TOKEN` — token bot uji dari `@BotFather`.
   - `TELEGRAM_OPERATOR_CHAT_ID` — user ID Telegram pribadi operator.
   - `TELEGRAM_CHANNEL_ID` — ID channel privat uji (mis. `-100xxxxxxxxxx`).
   - `TELEGRAM_DRY_RUN=0` — aktifkan pengiriman nyata ke Telegram uji.
   - `ANTHROPIC_API_KEY` dan `LLM_MOCK=0` (atau `LLM_MOCK=1` jika hanya menguji alur bot/DB).
3. Jalankan stack Docker (Postgres + layanan Radar):

```bash
docker compose up -d --build
docker compose logs -f radar
```

### 3.2 Verifikasi Perintah Operator (Chat Pribadi Operator)

Kirim perintah berikut satu per satu dari akun operator dan pastikan bot merespons benar:

1. `/bantuan` — menampilkan daftar lengkap perintah termasuk `/ringkasan` dan `/testdraf`.
2. `/status` — menampilkan status sistem (`AKTIF`), waktu `JST` & `WIB`, jumlah sumber, draf, dan antrean review.
3. `/ringkasan` — memicu pengiriman ringkasan harian sekarang ke chat pribadi operator.
4. `/testdraf` — membuat **draf uji staging** dengan tombol inline **Setuju / Edit / Tolak** di chat operator (**tidak** langsung memposting ke channel).
5. `/ambilulang <source_id>` (mis. `/ambilulang takaratomy-lineup`) — memaksa ambil ulang satu sumber dan melaporkan hasilnya.
6. `/log` — menampilkan riwayat eksekusi (`runs`) dan keputusan evaluasi terbaru.
7. `/review` — menampilkan antrean item yang menunggu tinjauan manusia.
8. `/ambang threshold_layak 1.15` — memperbarui parameter; uji juga input tidak valid (`/ambang tidak_ada 1` dan `/ambang threshold_layak abc`) untuk memastikan ditolak.
9. `/jeda` lalu `/status` (pastikan status berubah menjadi `DIJEDA`), kemudian `/lanjut` lalu `/status` (kembali `AKTIF`).

### 3.3 Uji Keamanan Akun Non-Operator

1. Gunakan akun Telegram kedua (bukan `TELEGRAM_OPERATOR_CHAT_ID`) untuk mengirim perintah `/status`, `/jeda`, `/ringkasan`, `/testdraf` ke bot.
2. **Syarat lulus:** bot **diam (mengabaikan)** semua pesan dan mencatat peringatan `non-operator` di log container (`docker compose logs radar`). Tidak ada perubahan status sistem atau draf.

### 3.4 Uji Tombol Persetujuan Draf (Setuju / Edit / Tolak)

Gunakan draf yang dibuat oleh `/testdraf`:

1. **Uji Tolak:** tekan tombol **Tolak** → status draf menjadi ditolak/diarsipkan; **tidak ada** pesan masuk ke channel privat uji.
2. **Uji Edit:** buat draf baru dengan `/testdraf`, tekan **Edit** → balas pesan prompt `force_reply` dengan teks revisi → pastikan teks draf diperbarui dan belum terkirim ke channel.
3. **Uji Setuju:** tekan tombol **Setuju** pada draf yang sudah direvisi → pastikan postingan muncul di **channel privat uji** dengan format rapi, tanpa tanda tangan admin, serta status draf tercatat `terkirim` beserta `pesan_telegram_id` dan ID operator yang menyetujui.

Hentikan stack staging setelah selesai bila tidak dipakai:

```bash
docker compose down
```

---

## Tahap 4 — Checklist Penerimaan Pra-Rilis (PRD §11)

Semua butir wajib lulus sebelum `TELEGRAM_CHANNEL_ID` diarahkan ke channel publik **Radar Tomica Jepang**:

- [ ] **Rilis uji:** model baru Sabtu ketiga terdeteksi, diklasifikasi, dan muncul di ringkasan operator ≤ 24 jam.
- [ ] **Harga:** 10 item uji menghasilkan `Landed`, `HargaPO`, rasio PO, dan label (termasuk minimal 2 item langka) yang cocok dengan hitungan manual (selisih ≤ Rp1.000).
- [ ] **Persetujuan:** draf tidak pernah terkirim ke channel sebelum tombol **Setuju** ditekan; **Tolak** mengarsipkan draf; data lebih tua dari 24 jam dihitung ulang saat **Setuju**.
- [ ] **Ketahanan prompt injection:** halaman uji berisi instruksi palsu tidak mengubah keluaran dan ditandai `REVIEW`.
- [ ] **Sumber gagal:** 2 kegagalan berturut-turut memicu peringatan ke operator dan sumber otomatis dijeda.
- [ ] **Simulasi mati 1 hari:** prosedur manual 10 menit (cek 3 sumber prioritas 1 secara langsung) diuji dan berhasil.
- [ ] **Privasi faceless & keamanan channel:** seluruh butir di [src/telegram/CHANNEL_CHECKLIST.md](../src/telegram/CHANNEL_CHECKLIST.md) telah diverifikasi, termasuk meninjau channel dari akun Telegram lain untuk memastikan tidak ada nama, nomor, foto, atau tanda tangan operator.
