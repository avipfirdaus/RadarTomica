/**
 * Glosarium berversi untuk prompt P1, P2, dan P3 (PRD §7 aturan #6).
 * Perubahan istilah wajib menaikkan GLOSSARY_VERSION agar jejak audit terjaga.
 */

export const GLOSSARY_VERSION = 'G@1' as const;

export interface GlossaryEntry {
  term: string;
  id: string;
  note?: string;
}

export const TOMICA_GLOSSARY: readonly GlossaryEntry[] = [
  { term: '初回特別仕様', id: 'edisi pertama (First Edition)' },
  { term: 'トミカプレミアム', id: 'Tomica Premium' },
  { term: 'トミカプレミアムunlimited / トミカプレミアム アンリミテッド', id: 'Tomica Premium Unlimited' },
  { term: '第3土曜日', id: 'Sabtu ketiga' },
  { term: 'メーカー希望小売価格', id: 'harga resmi (MSRP)' },
  { term: '税込', id: 'termasuk pajak' },
  { term: '廃盤 / 入れ替え', id: 'model yang digantikan' },
  { term: 'タカラトミーモールオリジナル', id: 'eksklusif Takara Tomy Mall' },
  { term: 'トミカショップオリジナル', id: 'eksklusif Tomica Shop' },
  { term: 'イオンオリジナル', id: 'eksklusif AEON' },
  { term: 'トイザらスオリジナル', id: 'eksklusif Toys"R"Us' },
  { term: 'ドリームトミカ', id: 'Dream Tomica (kolaborasi)' },
  { term: 'トミカくじ', id: 'Tomica Kuji (acak/lotre)' },
  { term: '福富トミカ / 福舞トミカ / 新春トミカ', id: 'seri Tahun Baru (acak/kotak misteri)' },
  { term: 'ロングタイプトミカ', id: 'Long Type Tomica' },
  { term: '予約', id: 'pre-order' },
] as const;

/** Format ringkas satu baris untuk bagian GLOSARIUM di prompt P1. */
export function formatGlossaryCompact(): string {
  return TOMICA_GLOSSARY.map((e) => `${e.term} = ${e.id}`).join('; ');
}

/** Format daftar berpoin untuk prompt P3 (ringkas & terjemah JA→ID). */
export function formatGlossaryList(): string {
  return TOMICA_GLOSSARY.map((e) => `- ${e.term}: ${e.id}`).join('\n');
}
