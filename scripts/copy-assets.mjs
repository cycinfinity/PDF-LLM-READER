#!/usr/bin/env node
/**
 * Copy third-party runtime assets into public/ so the app works fully offline:
 *  - pdf.js WASM decoders / cMaps / standard fonts (JBIG2, JPX, ICC, CJK CMaps)
 *  - tesseract.js worker + WASM core (OCR runs in the browser)
 *  - Tesseract language data (eng / chi_sim)
 *  - optional CJK font for the text-PDF layer (if present in node_modules)
 *
 * Run automatically via the npm "postinstall" script; also safe to run manually:
 *   node scripts/copy-assets.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');
const publicDir = join(root, 'public');

function resetDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function requirePath(path, hint) {
  if (!existsSync(path)) {
    console.error(`[copy-assets] missing ${path}\n  ${hint}`);
    process.exit(1);
  }
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function copyPdfJsAssets() {
  const pdfjs = join(nodeModules, 'pdfjs-dist');
  requirePath(pdfjs, 'Run `npm install` first.');
  const targets = [
    ['wasm', join(pdfjs, 'wasm')],
    ['cmaps', join(pdfjs, 'cmaps')],
    ['standard_fonts', join(pdfjs, 'standard_fonts')],
  ];
  for (const [name, source] of targets) {
    if (!existsSync(source)) continue;
    const destination = join(publicDir, 'pdfjs', name);
    resetDir(destination);
    cpSync(source, destination, { recursive: true });
    console.log(`[copy-assets] public/pdfjs/${name}`);
  }
}

function copyTesseractCore() {
  const tesseract = join(nodeModules, 'tesseract.js');
  requirePath(tesseract, 'Install tesseract.js (see package.json).');
  const worker = firstExisting([
    join(tesseract, 'dist', 'worker.min.js'),
    join(tesseract, 'dist', 'worker.js'),
  ]);
  if (!worker) {
    console.error('[copy-assets] tesseract.js worker not found');
    process.exit(1);
  }
  mkdirSync(join(publicDir, 'ocr'), { recursive: true });
  cpSync(worker, join(publicDir, 'ocr', 'worker.min.js'));

  const core = join(nodeModules, 'tesseract.js-core');
  requirePath(core, 'Install tesseract.js-core (transitive dependency of tesseract.js).');
  const coreDestination = join(publicDir, 'ocr', 'core');
  resetDir(coreDestination);

  // tesseract.js picks the best core for the browser at runtime: relaxed-SIMD,
  // SIMD, or plain, always the *LSTM* build (the app uses the default LSTM-only
  // OEM). Those variants embed the wasm inside the .wasm.js file, so we only
  // need to ship the three LSTM .wasm.js candidates instead of the full 50 MB
  // core directory. If a future tesseract.js-core changes its layout, fall back
  // to copying every JS/WASM file so the app keeps working.
  const preferred = readdirSync(core).filter((entry) =>
    /^tesseract-core-.*lstm\.wasm\.js$/.test(entry),
  );
  const fallback = readdirSync(core).filter(
    (entry) => /\.(js|wasm|wasm\.js)$/.test(entry) || entry === 'LICENSE',
  );
  const entries = preferred.length > 0 ? [...preferred, 'LICENSE'] : fallback;
  for (const entry of entries) {
    const source = join(core, entry);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    cpSync(source, join(coreDestination, entry));
  }
  console.log('[copy-assets] public/ocr/worker.min.js + public/ocr/core');
}

function copyLanguageData() {
  const dataRoot = join(nodeModules, '@tesseract.js-data');
  requirePath(
    dataRoot,
    'Install @tesseract.js-data/eng and @tesseract.js-data/chi_sim (see package.json).',
  );
  const languageDir = join(publicDir, 'ocr', 'lang');
  mkdirSync(languageDir, { recursive: true });

  const wanted = ['eng', 'chi_sim'];
  for (const language of wanted) {
    const packageRoot = join(dataRoot, language);
    if (!existsSync(packageRoot)) {
      console.error(`[copy-assets] missing language package @tesseract.js-data/${language}`);
      process.exit(1);
    }
    const versions = readdirSync(packageRoot)
      .filter((entry) => statSync(join(packageRoot, entry)).isDirectory())
      .sort()
      .reverse();
    const candidates = versions
      .map((version) => join(packageRoot, version, `${language}.traineddata.gz`))
      .concat(join(packageRoot, `${language}.traineddata.gz`));
    const source = firstExisting(candidates);
    if (!source) {
      console.error(`[copy-assets] ${language}.traineddata.gz not found under ${packageRoot}`);
      process.exit(1);
    }
    cpSync(source, join(languageDir, `${language}.traineddata.gz`));
    console.log(`[copy-assets] public/ocr/lang/${language}.traineddata.gz`);
  }
}

/** Optional: copy the first Noto Sans SC TTF we can find (used by the text-PDF layer). */
function copyCjkFont() {
  const fontsDestination = join(publicDir, 'fonts');
  mkdirSync(fontsDestination, { recursive: true });
  const candidates = [];
  const expoRoot = join(nodeModules, '@expo-google-fonts', 'noto-sans-sc');
  if (existsSync(expoRoot)) {
    for (const entry of readdirSync(expoRoot)) {
      if (/\.ttf$/i.test(entry)) candidates.push(join(expoRoot, entry));
    }
  }
  const tailwindFonts = join(nodeModules, '@fontsource', 'noto-sans-sc');
  if (existsSync(tailwindFonts)) {
    for (const entry of readdirSync(tailwindFonts)) {
      if (/\.ttf$/i.test(entry)) candidates.push(join(tailwindFonts, entry));
    }
  }
  const font = candidates[0];
  if (!font) {
    console.log('[copy-assets] no CJK TTF found; text-PDF export will use Helvetica (Latin only)');
    return;
  }
  cpSync(font, join(fontsDestination, 'NotoSansSC-Regular.ttf'));
  console.log('[copy-assets] public/fonts/NotoSansSC-Regular.ttf');
}

mkdirSync(publicDir, { recursive: true });
copyPdfJsAssets();
copyTesseractCore();
copyLanguageData();
copyCjkFont();
console.log('[copy-assets] done');
