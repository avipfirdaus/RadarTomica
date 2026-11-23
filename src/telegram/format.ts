/**
 * Utilitas pemformatan pesan Telegram (HTML & MarkdownV2 escaping, mata uang).
 */

/** Escape teks untuk parse_mode HTML Telegram. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Escape teks untuk parse_mode MarkdownV2 Telegram. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Format angka rupiah, mis. 157000 -> "Rp157.000". */
export function formatIdr(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}Rp${abs}`;
}

/** Format angka yen, mis. 594 -> "¥594" atau 1100 -> "¥1.100". */
export function formatJpy(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}¥${abs}`;
}

/** Format rasio PO, mis. 1.456 -> "1,46x". */
export function formatRatio(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '-';
  return `${ratio.toFixed(2).replace('.', ',')}x`;
}
