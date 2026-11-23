export {
  JP_CONSUMPTION_TAX_RATE,
  normalizeNameJa,
  normalizeTomicaNo,
  normalizeReleaseDateJst,
  normalizePriceJpy,
  slugifyName,
  buildCanonicalKey,
  normalizeExtractedItem,
  type NormalizedItemData,
} from './normalize.js';

export {
  isSpecialEdition,
  detectItemChanges,
  recordItemChanges,
  type DetectedChange,
} from './changes.js';

export {
  upsertExtractedItems,
  getPublishableFields,
  type UpsertExtractedItemInput,
  type UpsertInput,
  type UpsertResult,
  type PublishableField,
  type PublishableFieldsResult,
} from './upsert.js';
