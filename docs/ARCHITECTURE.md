# Arsitektur & Kontrak Pengembangan (v1: Fase 0 + Fase 1)

Acuan utama: [PRD.md](PRD.md). Bila ada konflik, **PRD menang**; catat penyimpangan di bagian "Keputusan" di bawah.

## Stack (keputusan operator, 23 Nov 2026)

| Lapisan | Pilihan | Catatan |
| --- | --- | --- |
| Bahasa | TypeScript (Node 22, ESM, `strict`) | Impor relatif wajib pakai sufiks `.js` |
| Basis data | Postgres / Supabase (`pg`); tes memakai PGlite in-process | Skema: `src/db/migrations/*.sql` |
| Jadwal | `croner` dengan zona `Asia/Tokyo` | Menggantikan n8n; n8n bisa memicu endpoint/CLI nanti |
| LLM | Anthropic SDK (`@anthropic-ai/sdk`) + `MockLlmClient` | `LLM_MOCK=1` untuk dev/tes |
| Telegram | `grammy` + `DryRunTelegram` | `TELEGRAM_DRY_RUN=1` untuk dev/tes |
| Validasi | `zod` v4 | Skema P1 di `src/shared/types.ts` |
| Tes | `vitest` | `npm test` |

Perbedaan dari PRD bagian 8: n8n + Google Sheets diganti service kode + Postgres agar bisa dites otomatis. Fungsi dan aturan tetap sama.

## Struktur modul & kepemilikan

```
src/
  shared/        types.ts (kontrak), time.ts, logger.ts         ← orkestrator
  config/        env.ts, params.ts                                ← orkestrator
  db/            client.ts, migrations/                           ← orkestrator (tambah migrasi baru: 00N_*.sql)
  ingest/        F1: fetcher, robots, rate-limit, html/pdf→teks, hash, sources registry   ← agen A
  scheduler/     jadwal JST, kontrol jeda, runs                   ← agen A
  extract/       F2: LLM client, prompt P1/P2/P3 (versi), validasi, verifikasi bukti, injection   ← agen B
  classify/      F5: aturan klasifikasi + P2                      ← agen B
  domain/        F3 normalize/dedup, F4 change detection          ← agen C
  pricing/       F6: landed, HargaPO, acuan, langka, label; FX provider   ← agen C
  calendar/      F7: Sabtu ketiga, kalender 90 hari               ← agen C
  telegram/      port grammY + DryRun, perintah operator          ← agen D
  notify/        F8: ringkasan harian, peringatan segera          ← agen D
  drafts/        F9: template, P4, gerbang Setuju/Edit/Tolak      ← agen D
  pipeline/      wiring end-to-end, main.ts, CLI                   ← orkestrator (integrasi)
tests/fixtures/  teks contoh (JP/EN), set uji 20 + halaman injection
```

## Aturan kerja sub-agen

1. **Hanya ubah folder milikmu** + tes di dalamnya (`*.test.ts` berdampingan dengan kode) dan `tests/fixtures/<modul>/`.
2. File milik orkestrator (`src/shared`, `src/config`, `src/db`, `package.json`) **jangan diubah**. Butuh field/tabel/dependensi baru? Laporkan di ringkasan akhir sebagai *permintaan perubahan kontrak*; boleh membuat migrasi baru `src/db/migrations/00N_<modul>.sql` (N: A=010, B=020, C=030, D=040) bila benar-benar perlu.
3. Jangan `git commit`/`push`; orkestrator yang mengelola git.
4. Semua hitungan harga, tanggal, dan keputusan di kode biasa — **LLM hanya membaca teks & menulis draf** (PRD §7).
5. Tidak ada akses jaringan dalam tes; pakai fixture & port mock.
6. Ekspor API publik modul lewat `src/<modul>/index.ts`.
7. Selesai = `npx tsc --noEmit` bersih **dan** `npx vitest run src/<modul>` hijau.

## Port lintas modul (lihat `src/shared/types.ts`)

- `LlmClient` (B mengimplementasi; D memakai untuk P4)
- `TelegramPort` (D mengimplementasi; A/C tidak memanggil langsung)
- `FxProvider` (C mengimplementasi)
- `Db` (`src/db/client.ts`), `loadParams`/`setParam` (`src/config/params.ts`), `withRun` (`src/shared/logger.ts`)

## Keputusan

- 2026-11-23: Stack TypeScript + Postgres; ruang lingkup Fase 0 + 1; kredensial via `.env` (mock dulu); alur git = branch fitur + PR.
