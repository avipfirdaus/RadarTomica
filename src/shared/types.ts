/**
 * Kontrak tipe bersama antar modul. Ubah file ini hanya lewat orkestrator
 * agar semua modul tetap sinkron.
 */
import { z } from 'zod';

// ---------- Enum domain (PRD bagian 5–7) ----------
export const EDITIONS = ['regular', 'first', 'premium', 'premium_unlimited', 'collab', 'exclusive', 'set', 'random', 'unknown'] as const;
export type Edition = (typeof EDITIONS)[number];

export const ITEM_STATUSES = ['announced', 'preorder', 'released', 'cancelled'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const LABELS = ['LAYAK', 'BATAS', 'TIDAK', 'REVIEW'] as const;
export type Label = (typeof LABELS)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const EVENT_KINDS = ['new', 'date', 'price', 'edition', 'cancelled'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const DRAFT_KINDS = ['monthly_release', 'po_open', 'reminder', 'po_close'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const DRAFT_STATUSES = ['draft', 'approved', 'rejected', 'sent', 'expired'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export type Market = 'JP-shop' | 'JP-used' | 'ID-marketplace';
export type ReferenceKind = 'ID-market' | 'JP-used';
export type SourceKind = 'page' | 'pdf' | 'pdf_index' | 'feed' | 'shop';
export type LlmTask = 'P1' | 'P2' | 'P3' | 'P4';

// ---------- Skema keluaran P1 (PRD bagian 7, wajib dipatuhi persis) ----------
export const EvidenceSchema = z.object({
  field: z.string(),
  quote_ja: z.string(),
  source_url: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ExtractedItemSchema = z.object({
  tomica_no: z.number().int().nullable(),
  name_ja: z.string().nullable(),
  name_id: z.string().nullable(),
  edition: z.enum(EDITIONS),
  release_date_jst: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  price_jpy_tax_incl: z.number().int().nullable(),
  replaces: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  confidence: z.enum(CONFIDENCES),
  needs_review: z.boolean(),
});
export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

export const P1OutputSchema = z.object({ items: z.array(ExtractedItemSchema) });
export type P1Output = z.infer<typeof P1OutputSchema>;

// ---------- Record basis data ----------
export interface SourceRow {
  id: string;
  name: string;
  url: string;
  priority: 1 | 2 | 3;
  kind: SourceKind;
  schedule: string;
  enabled: boolean;
  paused: boolean;
  last_status: string | null;
  last_error: string | null;
  last_fetched_at: Date | null;
  consecutive_failures: number;
}

export interface SnapshotRow {
  id: number;
  source_id: string;
  fetched_at: Date;
  content_hash: string;
  raw_text: string;
  final_url: string;
  extracted_at: Date | null;
}

export interface ItemRow {
  id: number;
  canonical_key: string;
  tomica_no: number | null;
  name_ja: string;
  name_id: string | null;
  category: string;
  edition: Edition;
  release_date_jst: string | null; // 'YYYY-MM-DD' JST
  price_jpy: number | null;
  status: ItemStatus;
  photo_url: string | null;
  is_rare: boolean;
  ignored: boolean;
  needs_review: boolean;
  replaces: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EventRow {
  id: number;
  item_id: number;
  kind: EventKind;
  old_value: unknown;
  new_value: unknown;
  important: boolean;
  created_at: Date;
  sent: boolean;
}

export interface PriceRow {
  id: number;
  item_id: number;
  market: Market;
  platform: string | null;
  seller: string | null;
  price: number;
  currency: 'JPY' | 'IDR';
  is_sold: boolean;
  in_stock: boolean | null;
  observed_at: Date;
  url: string | null;
}

export interface EvaluationRow {
  id: number;
  item_id: number;
  params_version: number;
  fx_idr_per_jpy: number;
  landed_idr: number | null;
  po_price_idr: number | null;
  reference_idr: number | null;
  reference_kind: ReferenceKind | null;
  data_count: number;
  po_ratio: number | null;
  label: Label;
  reason: string | null;
  created_at: Date;
}

export interface DraftRow {
  id: number;
  kind: DraftKind;
  item_ids: number[];
  text: string;
  status: DraftStatus;
  approved_by: string | null;
  approved_at: Date | null;
  telegram_message_id: string | null;
  operator_message_id: string | null;
  prompt_version: string | null;
  params_version: number | null;
  sources: { claim: string; url: string }[];
  data_as_of: Date;
  created_at: Date;
  expires_at: Date | null;
}

// ---------- Port lintas modul (diimplementasi modul masing-masing) ----------

/** Klien LLM. Implementasi: Anthropic (produksi) dan Mock (tes / LLM_MOCK=1). */
export interface LlmClient {
  complete(req: {
    task: LlmTask;
    promptVersion: string;
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }>;
}

/** Pengirim Telegram. Implementasi: grammY (produksi) dan DryRun (tes / TELEGRAM_DRY_RUN=1). */
export interface TelegramPort {
  sendToOperator(text: string, opts?: { buttons?: { text: string; data: string }[][] }): Promise<{ messageId: string }>;
  /** Satu-satunya jalur ke channel publik; hanya dipanggil oleh alur persetujuan draf (F9). */
  sendToChannel(text: string): Promise<{ messageId: string }>;
}

/** Penyedia kurs JPY→IDR. */
export interface FxProvider {
  getIdrPerJpy(): Promise<{ rate: number; asOf: Date; source: string }>;
}
