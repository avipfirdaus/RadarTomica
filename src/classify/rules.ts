/**
 * Aturan klasifikasi deterministik F5 (PRD §5 "Aturan klasifikasi").
 * Dijalankan lebih dulu sebelum memanggil P2 (LLM) untuk kasus ambigu.
 */
import { DateTime } from 'luxon';
import type { Edition, ExtractedItem } from '../shared/types.js';
import { JST, todayJst } from '../shared/time.js';

export interface ClassifyInput {
  item: Pick<ExtractedItem, 'tomica_no' | 'name_ja' | 'name_id' | 'edition' | 'release_date_jst'>;
  sourceText: string;
  /** Tanggal acuan (JST 'YYYY-MM-DD' atau Date) untuk memeriksa pekan rilis first edition. Default: todayJst(). */
  referenceDateJst?: string | Date;
  /** True bila operator secara eksplisit menandai item eksklusif toko boleh di-PO. */
  operatorAllowedPo?: boolean;
}

export interface DeterministicClassification {
  edition: Edition;
  category: string;
  isStoreExclusive: boolean;
  offerablePerModel: boolean;
  needsReview: boolean;
  ambiguous: boolean;
  reason: string;
}

const RANDOM_PATTERN =
  /トミカくじ|tomica\s*kuji|ミステリーボックス|mystery\s*box|ブラインド(?:ボックス|パッケージ)|blind\s*box|福袋|福富トミカ|福舞トミカ|fukumai\s*tomica|fukutomi\s*tomica|新春トミカ|初春トミカ|ランダム|何が出るかお楽しみ/i;

const STORE_EXCLUSIVE_PATTERN =
  /タカラトミーモールオリジナル|takara\s*tomy\s*mall\s*(?:original|exclusive)|トミカショップオリジナル|tomica\s*shop\s*(?:original|exclusive)|イオン(?:オリジナル|限定)|aeon\s*(?:original|exclusive)|トイザらス(?:オリジナル|限定)|toys\s*["”]?r["”]?\s*us\s*(?:original|exclusive)|セブン-?イレブン限定|ローソン限定|ファミマ限定|アピタ|ピアゴ|ヤマダデンキオリジナル|エディオンオリジナル|ジョーシンオリジナル|トミカ博|イベントモデル|event\s*model|特注トミカ|店舗限定|store\s*exclusive/i;

const SET_PATTERN = /トミカギフト|ギフトセット|gift\s*set|\d+台セット|セット(?:商品|販売)?/i;

const PREMIUM_UNLIMITED_PATTERN =
  /トミカプレミアム\s*(?:unlimited|アンリミテッド)|tomica\s*premium\s*unlimited/i;

const PREMIUM_PATTERN = /トミカプレミアム|tomica\s*premium/i;

const FIRST_EDITION_PATTERN = /初回特別仕様|first\s*edition/i;

const COLLAB_PATTERN =
  /ドリームトミカ|dream\s*tomica|ディズニーモータース|disney\s*motors|トミカ\s*[×x]\s*|コラボ|collaboration|カーズ\s*トミカ|cars\s*tomica|マリオカート|サンリオ|ちいかわ|すみっコぐらし/i;

const REGULAR_HINT_PATTERN = /通常版|通常仕様|トミカ\s*no\.?\s*\d+|tomica\s*no\.?\s*\d+/i;

/**
 * Memeriksa apakah `referenceDateJst` berada dalam pekan rilis (ISO week Senin–Minggu di JST)
 * dari `releaseDateJst`.
 */
export function isWithinReleaseWeek(releaseDateJst: string, referenceDateJst: string | Date = todayJst()): boolean {
  const rel = DateTime.fromISO(releaseDateJst, { zone: JST });
  const ref =
    typeof referenceDateJst === 'string'
      ? DateTime.fromISO(referenceDateJst, { zone: JST })
      : DateTime.fromJSDate(referenceDateJst).setZone(JST);

  if (!rel.isValid || !ref.isValid) return false;
  return rel.weekYear === ref.weekYear && rel.weekNumber === ref.weekNumber;
}

/**
 * Menjalankan aturan klasifikasi deterministik sesuai PRD §5.
 * Bila aturan tidak cukup pasti, mengembalikan `ambiguous: true` agar pemanggil
 * dapat menggunakan P2 (LLM) atau menandai REVIEW.
 */
export function classifyDeterministic(input: ClassifyInput): DeterministicClassification {
  const itemText = [input.item.name_ja ?? '', input.item.name_id ?? ''].join(' ').normalize('NFKC');
  const fullText = `${itemText}\n${input.sourceText}`.normalize('NFKC');
  const refDate = input.referenceDateJst ?? todayJst();

  // 1. Item acak (kuji, kotak misteri, seri tahun baru/福袋) -> hanya per paket, tidak per model.
  if (RANDOM_PATTERN.test(itemText) || (input.item.edition === 'random' && RANDOM_PATTERN.test(fullText))) {
    return {
      edition: 'random',
      category: 'random',
      isStoreExclusive: false,
      offerablePerModel: false,
      needsReview: false,
      ambiguous: false,
      reason: 'Item acak/kuji/seri tahun baru; tidak ditawarkan per model (hanya per paket bila operator memilih).',
    };
  }
  if (RANDOM_PATTERN.test(fullText) && input.item.tomica_no === null && !PREMIUM_PATTERN.test(itemText)) {
    return {
      edition: 'random',
      category: 'random',
      isStoreExclusive: false,
      offerablePerModel: false,
      needsReview: false,
      ambiguous: false,
      reason: 'Teks sumber menandai item acak/kuji/kotak misteri; tidak ditawarkan per model.',
    };
  }

  // 2. Eksklusif toko/acara -> tidak diproses sebagai PO kecuali operator menandai.
  if (
    STORE_EXCLUSIVE_PATTERN.test(itemText) ||
    (STORE_EXCLUSIVE_PATTERN.test(fullText) && input.item.edition === 'exclusive') ||
    (STORE_EXCLUSIVE_PATTERN.test(fullText) && input.item.tomica_no === null && !FIRST_EDITION_PATTERN.test(itemText))
  ) {
    const allowed = Boolean(input.operatorAllowedPo);
    return {
      edition: 'exclusive',
      category: 'exclusive',
      isStoreExclusive: true,
      offerablePerModel: allowed,
      needsReview: false,
      ambiguous: false,
      reason: allowed
        ? 'Eksklusif satu jaringan toko/acara; diizinkan PO oleh penandaan operator.'
        : 'Eksklusif satu jaringan toko/acara; tidak ditawarkan sebagai PO kecuali operator menandai.',
    };
  }

  // 3. Paket/Set (gift set / multi-car set) -> tidak ditawarkan per model.
  if (SET_PATTERN.test(itemText) || (input.item.edition === 'set' && SET_PATTERN.test(fullText))) {
    return {
      edition: 'set',
      category: 'set',
      isStoreExclusive: false,
      offerablePerModel: false,
      needsReview: false,
      ambiguous: false,
      reason: 'Produk berbentuk set/gift set; hanya ditawarkan per paket.',
    };
  }

  // 4. Tomica Premium Unlimited
  if (PREMIUM_UNLIMITED_PATTERN.test(itemText) || (PREMIUM_UNLIMITED_PATTERN.test(fullText) && input.item.edition !== 'regular')) {
    return {
      edition: 'premium_unlimited',
      category: 'premium_unlimited',
      isStoreExclusive: false,
      offerablePerModel: true,
      needsReview: false,
      ambiguous: false,
      reason: 'Nama seri memuat Tomica Premium Unlimited.',
    };
  }

  // 5. Tomica Premium
  if (PREMIUM_PATTERN.test(itemText) || (PREMIUM_PATTERN.test(fullText) && input.item.edition !== 'regular')) {
    return {
      edition: 'premium',
      category: 'premium',
      isStoreExclusive: false,
      offerablePerModel: true,
      needsReview: false,
      ambiguous: false,
      reason: 'Nama seri memuat トミカプレミアム / tomica PREMIUM.',
    };
  }

  // 6. First Edition: wajib memuat 初回特別仕様 / First Edition DAN dalam pekan rilis modelnya.
  const mentionsFirst =
    FIRST_EDITION_PATTERN.test(itemText) ||
    ((input.item.edition === 'first' || input.item.edition === 'unknown') && FIRST_EDITION_PATTERN.test(fullText));

  if (mentionsFirst) {
    if (!input.item.release_date_jst) {
      return {
        edition: 'unknown',
        category: 'unknown',
        isStoreExclusive: false,
        offerablePerModel: false,
        needsReview: true,
        ambiguous: true,
        reason: 'Menyebut 初回特別仕様/First Edition namun tanggal rilis kosong sehingga pekan rilis tidak dapat diverifikasi.',
      };
    }

    if (isWithinReleaseWeek(input.item.release_date_jst, refDate)) {
      return {
        edition: 'first',
        category: 'first',
        isStoreExclusive: false,
        offerablePerModel: true,
        needsReview: false,
        ambiguous: false,
        reason: `Menyebut 初回特別仕様/First Edition dalam pekan rilis (${input.item.release_date_jst}).`,
      };
    }

    return {
      edition: 'regular',
      category: 'regular',
      isStoreExclusive: false,
      offerablePerModel: true,
      needsReview: false,
      ambiguous: false,
      reason: `Menyebut 初回特別仕様/First Edition namun di luar pekan rilis (${input.item.release_date_jst}); tidak diklasifikasikan sebagai first edition.`,
    };
  }

  // 7. Kolaborasi (Dream Tomica, Disney Motors, kolaborasi karakter/merek)
  if (COLLAB_PATTERN.test(itemText) || (COLLAB_PATTERN.test(fullText) && input.item.tomica_no === null)) {
    return {
      edition: 'collab',
      category: 'collab',
      isStoreExclusive: false,
      offerablePerModel: true,
      needsReview: false,
      ambiguous: false,
      reason: 'Produk seri kolaborasi / Dream Tomica.',
    };
  }

  // 8. Regular mainline (bernomor Tomica No. atau penanda edisi biasa)
  if (input.item.tomica_no !== null || REGULAR_HINT_PATTERN.test(fullText)) {
    return {
      edition: 'regular',
      category: 'regular',
      isStoreExclusive: false,
      offerablePerModel: true,
      needsReview: false,
      ambiguous: false,
      reason:
        input.item.tomica_no !== null
          ? `Model mainline bernomor (No.${input.item.tomica_no}) tanpa penanda edisi khusus.`
          : 'Penanda model Tomica regular tanpa edisi khusus.',
    };
  }

  // 9. Ambigu -> serahkan ke P2 (LLM) atau REVIEW.
  return {
    edition: 'unknown',
    category: 'unknown',
    isStoreExclusive: false,
    offerablePerModel: false,
    needsReview: true,
    ambiguous: true,
    reason: 'Aturan deterministik tidak menemukan penanda kategori yang cukup pasti.',
  };
}
