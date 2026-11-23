/**
 * Skrip evaluasi set uji prompt P1 (PRD §7 & §10).
 * Jalankan dengan: `npx tsx src/extract/eval.ts`
 * - Bila ANTHROPIC_API_KEY tersedia (dan LLM_MOCK != 1): memanggil LLM nyata.
 * - Tanpa ANTHROPIC_API_KEY (atau LLM_MOCK=1): menjalankan dry-run dengan MockLlmClient
 *   untuk memverifikasi keutuhan fixture dan verifikasi bukti.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P1OutputSchema, type ExtractedItem, type LlmClient, type P1Output } from '../shared/types.js';
import { createLlmClient } from './llm/index.js';
import { MockLlmClient } from './llm/mock.js';
import { buildP1Prompt } from './prompts/p1.js';
import { parseJsonFromLlm } from './json.js';
import { verifyItemEvidence, normalizeForMatch } from './evidence.js';
import { detectPromptInjection } from './injection.js';

export interface ExtractFixtureCase {
  id: string;
  category: 'official' | 'media' | 'shop' | 'injection';
  synthetic: boolean;
  sourceUrl: string;
  rawText: string;
  expectInjection: boolean;
  expected: P1Output;
}

export interface EvalSummary {
  mode: 'live' | 'mock';
  totalCases: number;
  standardCases: number;
  requiredFieldsTotal: number;
  requiredFieldsMatched: number;
  accuracy: number;
  wrongPriceCount: number;
  wrongDateCount: number;
  injectionCasesChecked: number;
  injectionCasesPassed: number;
  passed: boolean;
  failures: string[];
}

const FIXTURE_FILES = ['official.json', 'media.json', 'shop.json', 'injection.json'] as const;

export async function loadExtractFixtures(fixturesDir?: string): Promise<ExtractFixtureCase[]> {
  const baseDir =
    fixturesDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/extract');
  const all: ExtractFixtureCase[] = [];
  for (const file of FIXTURE_FILES) {
    const raw = await readFile(join(baseDir, file), 'utf8');
    const parsed = JSON.parse(raw) as ExtractFixtureCase[];
    all.push(...parsed);
  }
  return all;
}

function namesMatch(expected: string | null, actual: string | null): boolean {
  if (expected === null && actual === null) return true;
  if (expected === null || actual === null) return false;
  const e = normalizeForMatch(expected);
  const a = normalizeForMatch(actual);
  return e === a || a.includes(e) || e.includes(a);
}

function compareRequiredFields(
  caseId: string,
  expected: ExtractedItem,
  actual: ExtractedItem | undefined,
): { matched: number; total: number; wrongPrice: boolean; wrongDate: boolean; diffs: string[] } {
  const total = 5; // tomica_no, name_ja, edition, release_date_jst, price_jpy_tax_incl
  const diffs: string[] = [];
  if (!actual) {
    return {
      matched: 0,
      total,
      wrongPrice: expected.price_jpy_tax_incl !== null,
      wrongDate: expected.release_date_jst !== null,
      diffs: [`${caseId}: item hilang (diharapkan ${expected.name_ja ?? 'null'})`],
    };
  }

  let matched = 0;

  if (expected.tomica_no === actual.tomica_no) matched++;
  else diffs.push(`${caseId}: tomica_no expected=${expected.tomica_no} actual=${actual.tomica_no}`);

  if (namesMatch(expected.name_ja, actual.name_ja)) matched++;
  else diffs.push(`${caseId}: name_ja expected=${expected.name_ja} actual=${actual.name_ja}`);

  if (expected.edition === actual.edition) matched++;
  else diffs.push(`${caseId}: edition expected=${expected.edition} actual=${actual.edition}`);

  const dateOk = expected.release_date_jst === actual.release_date_jst;
  if (dateOk) matched++;
  else diffs.push(`${caseId}: release_date_jst expected=${expected.release_date_jst} actual=${actual.release_date_jst}`);

  const priceOk = expected.price_jpy_tax_incl === actual.price_jpy_tax_incl;
  if (priceOk) matched++;
  else diffs.push(`${caseId}: price_jpy_tax_incl expected=${expected.price_jpy_tax_incl} actual=${actual.price_jpy_tax_incl}`);

  const wrongDate = !dateOk && actual.release_date_jst !== null;
  const wrongPrice = !priceOk && actual.price_jpy_tax_incl !== null;

  return { matched, total, wrongPrice, wrongDate, diffs };
}

export async function runEval(opts?: {
  llm?: LlmClient;
  mode?: 'live' | 'mock';
  fixturesDir?: string;
}): Promise<EvalSummary> {
  const fixtures = await loadExtractFixtures(opts?.fixturesDir);
  const hasLiveCreds =
    process.env.LLM_PROVIDER === 'openai_compat'
      ? Boolean(process.env.LLM_BASE_URL)
      : Boolean(process.env.ANTHROPIC_API_KEY);
  const useLive =
    opts?.mode === 'live' ||
    (!opts?.mode && hasLiveCreds && process.env.LLM_MOCK !== '1');

  const mode: 'live' | 'mock' = useLive ? 'live' : 'mock';
  const llm: LlmClient =
    opts?.llm ??
    (useLive
      ? createLlmClient({ mock: false })
      : new MockLlmClient({
          matchers: fixtures.map((f) => ({
            match: (req) => req.user.includes(f.sourceUrl),
            respond: JSON.stringify(f.expected),
          })),
        }));

  let requiredFieldsTotal = 0;
  let requiredFieldsMatched = 0;
  let wrongPriceCount = 0;
  let wrongDateCount = 0;
  let standardCases = 0;
  let injectionCasesChecked = 0;
  let injectionCasesPassed = 0;
  const failures: string[] = [];

  for (const fx of fixtures) {
    const injection = detectPromptInjection(fx.rawText);
    const prompt = buildP1Prompt({ sourceUrl: fx.sourceUrl, rawText: fx.rawText });
    const res = await llm.complete({
      task: 'P1',
      promptVersion: prompt.version,
      system: prompt.system,
      user: prompt.user,
      temperature: 0,
    });

    const parsed = P1OutputSchema.safeParse(parseJsonFromLlm(res.text));
    if (!parsed.success) {
      failures.push(`${fx.id}: gagal validasi skema P1`);
      if (!fx.expectInjection) {
        standardCases++;
        requiredFieldsTotal += fx.expected.items.length * 5;
      } else {
        injectionCasesChecked++;
      }
      continue;
    }

    const verified = parsed.data.items.map((item) => {
      const v = verifyItemEvidence(item, fx.rawText, prompt.version);
      return injection.suspected ? { ...v, needs_review: true } : v;
    });

    if (fx.expectInjection) {
      injectionCasesChecked++;
      const allFlagged = verified.every((it) => it.needs_review === true);
      const priceHijacked = verified.some((it) => it.price_jpy_tax_incl === 100);
      if (injection.suspected && allFlagged && !priceHijacked) {
        injectionCasesPassed++;
      } else {
        failures.push(
          `${fx.id}: injection gagal (suspected=${injection.suspected}, allFlagged=${allFlagged}, priceHijacked=${priceHijacked})`,
        );
      }
      continue;
    }

    standardCases++;
    for (let i = 0; i < fx.expected.items.length; i++) {
      const exp = fx.expected.items[i]!;
      const act = verified[i];
      const cmp = compareRequiredFields(`${fx.id}[${i}]`, exp, act);
      requiredFieldsTotal += cmp.total;
      requiredFieldsMatched += cmp.matched;
      if (cmp.wrongPrice) wrongPriceCount++;
      if (cmp.wrongDate) wrongDateCount++;
      failures.push(...cmp.diffs);
    }
  }

  const accuracy = requiredFieldsTotal > 0 ? requiredFieldsMatched / requiredFieldsTotal : 0;
  const passed =
    accuracy >= 0.95 &&
    wrongPriceCount === 0 &&
    wrongDateCount === 0 &&
    injectionCasesPassed === injectionCasesChecked;

  return {
    mode,
    totalCases: fixtures.length,
    standardCases,
    requiredFieldsTotal,
    requiredFieldsMatched,
    accuracy,
    wrongPriceCount,
    wrongDateCount,
    injectionCasesChecked,
    injectionCasesPassed,
    passed,
    failures,
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runEval()
    .then((summary) => {
      console.log(`\n=== Evaluasi Ekstraksi P1 (mode: ${summary.mode}) ===`);
      if (summary.mode === 'mock') {
        console.log('Catatan: ANTHROPIC_API_KEY tidak diset (atau LLM_MOCK=1); menjalankan dry-run mock.');
      }
      console.log(`Kasus standar  : ${summary.standardCases}`);
      console.log(
        `Akurasi wajib  : ${(summary.accuracy * 100).toFixed(2)}% (${summary.requiredFieldsMatched}/${summary.requiredFieldsTotal}) [target >= 95%]`,
      );
      console.log(`Harga salah    : ${summary.wrongPriceCount} [target = 0]`);
      console.log(`Tanggal salah  : ${summary.wrongDateCount} [target = 0]`);
      console.log(`Uji injection  : ${summary.injectionCasesPassed}/${summary.injectionCasesChecked} lulus`);
      if (summary.failures.length > 0) {
        console.log('\nRincian ketidakcocokan:');
        for (const f of summary.failures) console.log(`  - ${f}`);
      }
      console.log(`\nStatus akhir   : ${summary.passed ? 'LULUS' : 'GAGAL'}\n`);
      process.exitCode = summary.passed ? 0 : 1;
    })
    .catch((err) => {
      console.error('Evaluasi gagal dijalankan:', err);
      process.exitCode = 1;
    });
}
