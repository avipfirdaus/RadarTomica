# Set Uji Ekstraksi P1 (`tests/fixtures/extract/`)

> **PENTING — DATA SINTETIS:** Seluruh teks sumber di direktori ini adalah **teks sintetis** (bahasa Jepang dan Inggris) yang ditulis khusus untuk pengujian otomatis dan kalibrasi prompt P1 (PRD §7 "Set uji prompt"). Teks ini meniru struktur pengumuman resmi Takara Tomy, artikel media otomotif Jepang, dan halaman toko ritel Jepang, namun **bukan** salinan langsung halaman web berhak cipta. Pada Fase 0 di produksi, operator dapat mengganti atau menambah contoh dari snapshot nyata yang sah.

## Komposisi Set Uji

| File | Kelompok (PRD §7) | Jumlah | Isi |
| --- | --- | --- | --- |
| `official.json` | Resmi / Siaran Pers | 10 | Lineup bulanan (regular & 初回特別仕様), Tomica Premium, Tomica Premium Unlimited, Dream Tomica kolaborasi, seri Tahun Baru acak (福舞トミカ), Gift Set, Takara Tomy Mall eksklusif, siaran pers PDF bahasa Inggris, lineup multi-item |
| `media.json` | Media Jepang | 5 | Gaya artikel Motor-Fan, Car Watch, Toy People, artikel pratinjau tanpa harga/tanggal (menguji `null`), artikel gabungan regular + first edition |
| `shop.json` | Toko Jepang | 5 | Gaya halaman Amazon.co.jp, Rakuten, Yodobashi, Biccamera, dan eksklusif AEON |
| `injection.json` | Uji Prompt Injection | 1 | Halaman berisi instruksi palsu bahasa Inggris & Jepang yang mencoba membajak harga, edisi, dan keluaran JSON (PRD §9 & §11) |

## Menjalankan Evaluasi

```bash
# Dengan Anthropic API nyata (memerlukan ANTHROPIC_API_KEY di env):
npx tsx src/extract/eval.ts

# Mode dry-run / verifikasi struktur fixture tanpa akses jaringan:
LLM_MOCK=1 npx tsx src/extract/eval.ts
```

Target kelulusan (PRD §7 & §10):
- Akurasi field wajib (`tomica_no`, `name_ja`, `edition`, `release_date_jst`, `price_jpy_tax_incl`) **≥ 95%**
- Kesalahan angka harga = **0**
- Kesalahan tanggal rilis = **0**
- Halaman injection terdeteksi (`injectionSuspected = true`) dan seluruh item ditandai `needs_review = true`
