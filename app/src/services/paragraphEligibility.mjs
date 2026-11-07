import { validateParagraphText } from './paragraph.mjs';

const CHAPTER_COUNT = 40;
const CHAPTER_PAGES = 25;
const PARAGRAPHS_PER_PAGE = 4;
const FIXTURE_MATH = '$x^2 + y^2 = z^2$';
const ASSET = 'figures/calibration.png';
const RENAMED_ASSET = 'figures/calibration-renamed.png';
const chapterName = chapter => 'chapters/chapter-' + String(chapter).padStart(2, '0');
const mainFixture = String.raw`\documentclass{article}
\usepackage{graphicx}
\usepackage{epstopdf-base}
\setlength{\parindent}{0pt}
\newcommand{\ReferenceCheck}{Reference Check Early \pageref{chapter:1} Middle \pageref{chapter:20} Late \pageref{chapter:40}\par}
\begin{document}
${Array.from({ length: CHAPTER_COUNT }, (_, index) => '\\include{' + chapterName(index + 1) + '}').join('\n')}
\end{document}
`;
const normalPath = path => path.replace(/^\//, '');

function asSource(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(value); } catch {}
  }
  return null;
}

function squareFixturePng(value) {
  if (!(value instanceof Uint8Array) || value.length < 24) return false;
  const bytes = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return bytes.getUint32(0) === 0x89504e47 && bytes.getUint32(4) === 0x0d0a1a0a &&
    bytes.getUint32(12) === 0x49484452 && bytes.getUint32(16) === 1024 && bytes.getUint32(20) === 1024;
}

function scopedProse(text) {
  try { validateParagraphText(text); } catch { return false; }
  const math = text.match(/\$[^$]*\$/g) || [];
  return math.every(expression => expression === FIXTURE_MATH);
}

function parseChapter(source, chapter, assetPath) {
  if (!source?.endsWith('\n')) return null;
  const lines = source.slice(0, -1).split('\n');
  const pages = [];
  let index = 0;
  let offset = 0;
  const take = expected => {
    if (lines[index] !== expected) return false;
    offset += lines[index++].length + 1;
    return true;
  };
  for (let page = 1; index < lines.length; page++) {
    if (page > CHAPTER_PAGES + Number(chapter === 20)) return null;
    if (page > 1 && !take(String.raw`\newpage`)) return null;
    if (!take(String.raw`\textbf{Chapter ${chapter} Local Page ${page}}\par`)) return null;
    if (page === 1) {
      if (!take(String.raw`\label{chapter:${chapter}}`)) return null;
      if (chapter === 1 || chapter === CHAPTER_COUNT) {
        if (!take(String.raw`\ReferenceCheck`)) return null;
        if (assetPath === RENAMED_ASSET &&
            !take(String.raw`\IfFileExists{${ASSET}}{\errmessage{Stale project file}}{}`)) return null;
        if (!take(String.raw`\includegraphics[width=1.5in]{${assetPath}}\par`)) return null;
      }
      if (chapter === 20) {
        const marker = lines[index];
        if (!/^Revision Marker [A-Za-z]+\\par$/.test(marker || '') || !take(marker)) return null;
      }
    }
    const paragraphs = [];
    for (let paragraph = 1; paragraph <= PARAGRAPHS_PER_PAGE; paragraph++) {
      const start = offset;
      while (index < lines.length && !lines[index].endsWith(String.raw`\par`)) {
        if (!take(lines[index])) return null;
      }
      if (index >= lines.length) return null;
      const end = offset + lines[index].length - 4;
      const text = source.slice(start, end);
      if (!scopedProse(text) || !take(lines[index])) return null;
      paragraphs.push({ text, start, end, page, paragraph });
    }
    pages.push({ page, paragraphs });
  }
  return pages.length >= CHAPTER_PAGES ? { chapter, pages } : null;
}

export function createBookParagraphProfile(mainSource, files) {
  if (mainSource !== mainFixture || !files) return null;
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  if (entries.length !== CHAPTER_COUNT + 1) return null;
  const normalized = new Map(entries.map(([path, data]) => [normalPath(path), data]));
  if (normalized.size !== entries.length) return null;
  const assetPath = normalized.has(ASSET) ? ASSET : RENAMED_ASSET;
  if (!squareFixturePng(normalized.get(assetPath))) return null;
  const chapters = new Map();
  for (let chapter = 1; chapter <= CHAPTER_COUNT; chapter++) {
    const path = chapterName(chapter) + '.tex';
    const parsed = parseChapter(asSource(normalized.get(path)), chapter, assetPath);
    if (!parsed) return null;
    chapters.set(path, parsed);
  }
  return { chapters, assetPath };
}

export function getBookParagraphEdit(profile, chapterPath, previousSource, nextSource) {
  if (!profile || typeof chapterPath !== 'string' || typeof previousSource !== 'string' ||
      typeof nextSource !== 'string' || previousSource === nextSource) return null;
  const reference = profile.chapters.get(normalPath(chapterPath));
  if (!reference) return null;
  const before = parseChapter(previousSource, reference.chapter, profile.assetPath);
  const after = parseChapter(nextSource, reference.chapter, profile.assetPath);
  if (!before || !after || before.pages.length !== reference.pages.length ||
      before.pages.length !== after.pages.length) return null;

  const original = before.pages.flatMap(page => page.paragraphs);
  const edited = after.pages.flatMap(page => page.paragraphs);
  let previousEnd = 0;
  let nextEnd = 0;
  let candidate = null;
  for (let index = 0; index < original.length; index++) {
    const a = original[index];
    const b = edited[index];
    if (previousSource.slice(previousEnd, a.start) !== nextSource.slice(nextEnd, b.start)) return null;
    previousEnd = a.end;
    nextEnd = b.end;
    if (a.text === b.text) continue;
    if (candidate) return null;
    const math = text => (text.match(/\$[^$]*\$/g) || []).join('\n');
    if (math(a.text) !== math(b.text)) return null;
    candidate = {
      chapter: reference.chapter, page: a.page, paragraph: a.paragraph,
      before: a.text, after: b.text, start: b.start, end: b.end,
    };
  }
  return previousSource.slice(previousEnd) === nextSource.slice(nextEnd) ? candidate : null;
}
