-- 001_init.sql — Skema v1 Radar Tomica (PRD bagian 6).
-- Konvensi: stempel waktu = timestamptz (UTC); tanggal rilis = date (JST, tanpa jam);
-- yen = integer; tidak ada data pribadi pembeli.

CREATE TABLE IF NOT EXISTS sources (
  id                   text PRIMARY KEY,               -- slug, mis. 'takaratomy-lineup'
  name                 text NOT NULL,
  url                  text NOT NULL,
  priority             integer NOT NULL CHECK (priority IN (1, 2, 3)),
  kind                 text NOT NULL CHECK (kind IN ('page', 'pdf', 'pdf_index', 'feed', 'shop')),
  schedule             text NOT NULL,                  -- label jadwal, mis. 'p1' (06:00 & 18:00 JST)
  enabled              boolean NOT NULL DEFAULT true,
  paused               boolean NOT NULL DEFAULT false, -- true otomatis setelah 2 gagal berturut
  last_status          text,                           -- 'ok' | 'unchanged' | 'error' | 'blocked_robots'
  last_error           text,
  last_fetched_at      timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshots (
  id            bigserial PRIMARY KEY,
  source_id     text NOT NULL REFERENCES sources(id),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  content_hash  text NOT NULL,                         -- sha256 teks utama yang sudah dibersihkan
  raw_text      text NOT NULL,
  final_url     text NOT NULL,
  extracted_at  timestamptz,                           -- null = belum diproses F2
  UNIQUE (source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS items (
  id               bigserial PRIMARY KEY,
  canonical_key    text NOT NULL UNIQUE,               -- slug(name_ja) + edition + release_date
  tomica_no        integer,
  name_ja          text NOT NULL,
  name_id          text,
  category         text NOT NULL DEFAULT 'regular',    -- lihat Category di src/shared/types.ts
  edition          text NOT NULL DEFAULT 'unknown',    -- lihat Edition
  release_date_jst date,
  price_jpy        integer,
  status           text NOT NULL DEFAULT 'announced' CHECK (status IN ('announced', 'preorder', 'released', 'cancelled')),
  photo_url        text,
  is_rare          boolean NOT NULL DEFAULT false,
  ignored          boolean NOT NULL DEFAULT false,     -- kontrol operator: tandai abaikan
  needs_review     boolean NOT NULL DEFAULT false,
  replaces         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS item_sources (
  id             bigserial PRIMARY KEY,
  item_id        bigint NOT NULL REFERENCES items(id),
  snapshot_id    bigint NOT NULL REFERENCES snapshots(id),
  field          text NOT NULL,
  value          jsonb,
  confidence     text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  quote          text,                                 -- kutipan bukti (< 15 kata), terverifikasi ada di teks
  source_url     text,
  prompt_version text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  item_id     bigint NOT NULL REFERENCES items(id),
  kind        text NOT NULL CHECK (kind IN ('new', 'date', 'price', 'edition', 'cancelled')),
  old_value   jsonb,
  new_value   jsonb,
  important   boolean NOT NULL DEFAULT false,          -- antre peringatan segera (F8)
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent        boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS prices (
  id          bigserial PRIMARY KEY,
  item_id     bigint NOT NULL REFERENCES items(id),
  market      text NOT NULL CHECK (market IN ('JP-shop', 'JP-used', 'ID-marketplace')),
  platform    text,                                    -- mis. 'mercari', 'tokopedia'
  seller      text,
  price       integer NOT NULL,                        -- bilangan bulat dalam mata uang asal
  currency    text NOT NULL CHECK (currency IN ('JPY', 'IDR')),
  is_sold     boolean NOT NULL DEFAULT false,          -- JP-used: harga terjual (bukan harga tawar)
  in_stock    boolean,
  observed_at timestamptz NOT NULL DEFAULT now(),
  url         text
);

CREATE TABLE IF NOT EXISTS evaluations (
  id              bigserial PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES items(id),
  params_version  integer NOT NULL,
  fx_idr_per_jpy  numeric NOT NULL,
  landed_idr      integer,
  po_price_idr    integer,
  reference_idr   integer,
  reference_kind  text CHECK (reference_kind IN ('ID-market', 'JP-used')),
  data_count      integer NOT NULL DEFAULT 0,
  po_ratio        numeric,
  label           text NOT NULL CHECK (label IN ('LAYAK', 'BATAS', 'TIDAK', 'REVIEW')),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drafts (
  id                  bigserial PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('monthly_release', 'po_open', 'reminder', 'po_close')),
  item_ids            bigint[] NOT NULL DEFAULT '{}',
  text                text NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'sent', 'expired')),
  approved_by         text,                            -- Telegram user id operator
  approved_at         timestamptz,
  telegram_message_id text,
  operator_message_id text,                            -- pesan review di chat pribadi operator
  prompt_version      text,
  params_version      integer,
  sources             jsonb NOT NULL DEFAULT '[]',     -- [{claim, url}]
  data_as_of          timestamptz NOT NULL DEFAULT now(), -- untuk aturan hitung ulang > 24 jam
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz
);

CREATE TABLE IF NOT EXISTS params (
  id              bigserial PRIMARY KEY,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  changed_by      text NOT NULL DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS params_key_idx ON params (key, effective_from DESC);

CREATE TABLE IF NOT EXISTS channel_stats (
  date                 date PRIMARY KEY,
  members              integer,
  avg_views            integer,
  replies              integer,
  form_entries         integer,
  how_to_order_askers  integer
);

CREATE TABLE IF NOT EXISTS runs (
  id               bigserial PRIMARY KEY,
  module           text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error', 'skipped')),
  processed_count  integer NOT NULL DEFAULT 0,
  error            text
);

-- Tabel pendukung (di luar 11 tabel PRD, dibutuhkan untuk kontrol & NFR).
CREATE TABLE IF NOT EXISTS system_state (
  key        text PRIMARY KEY,                         -- mis. 'paused'
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id              bigserial PRIMARY KEY,
  task            text NOT NULL CHECK (task IN ('P1', 'P2', 'P3', 'P4')),
  prompt_version  text NOT NULL,
  model           text NOT NULL,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  cost_usd        numeric NOT NULL DEFAULT 0,
  ok              boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_queue (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,                           -- 'extraction_failed' | 'injection_suspected' | 'classification' ...
  snapshot_id bigint REFERENCES snapshots(id),
  item_id     bigint REFERENCES items(id),
  reason      text NOT NULL,
  payload     jsonb,
  resolved    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
