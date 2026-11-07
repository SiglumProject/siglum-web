export const FIXTURE_PARAGRAPH = String.raw`This synthetic chapter records repeatable measurements for a full LaTeX project.
The chapter text includes ordinary paragraphs, inline mathematics $x^2 + y^2 = z^2$,
and stable landmarks for checking that generated pages reach the end of the document.`;

export const HYPHEN_ASSET = '/hyphen.tex';
const HYPHEN_SHA256 = '2c18acdc04c1a066aeb1759905e7ca449f0616c314b5ed6aebe55b9d4a89b8d4';

export const FONT_NAMES = ['cmr10', 'cmr7', 'cmr5', 'cmmi10', 'cmmi7', 'cmmi5', 'cmsy10', 'cmsy7', 'cmsy5', 'cmex10'];

export function validateParagraphText(paragraph) {
  const text = paragraph.trim();
  if (text.length > 420 || text.includes('^^') || /\n[ \t]*\n/.test(text) ||
      !/^[A-Za-z0-9 ,.!?;:"'()\n$^+=-]+$/.test(text)) {
    throw new Error('Unsupported paragraph syntax');
  }
  const parts = text.split('$');
  if (parts.length % 2 === 0 || parts.some((part, index) => index % 2
    ? !/^[A-Za-z0-9 ^+=-]+$/.test(part)
    : part.includes('^'))) throw new Error('Unsupported inline math');
  return text;
}

export function makeParagraphSource(paragraph, { traceParagraph = false, useEnglishPatterns = false } = {}) {
  const text = validateParagraphText(paragraph);
  return String.raw`\catcode123=1 \catcode125=2 \catcode36=3 \catcode94=7
${useEnglishPatterns ? String.raw`\catcode37=14
\language=0
\lefthyphenmin=2 \righthyphenmin=3 \uchyph=1
\defaulthyphenchar=45
\hyphenpenalty=50 \exhyphenpenalty=50
\doublehyphendemerits=10000 \finalhyphendemerits=5000 \adjdemerits=10000
\input hyphen.tex` : ''}
\pdfoutput=1
\pdfpagewidth=8.5in
\pdfpageheight=2in
\hsize=345pt
\vsize=2in
\parindent=0pt
\baselineskip=12pt
\lineskip=1pt
\lineskiplimit=0pt
\parfillskip=0pt plus 1fil
\pretolerance=100
\tolerance=200
\binoppenalty=700
\relpenalty=500
\linepenalty=10
\scriptspace=0.5pt
\sfcode46=3000 \sfcode63=3000 \sfcode33=3000
\sfcode58=2000 \sfcode59=1500 \sfcode44=1250
\sfcode41=0 \sfcode93=0 \sfcode39=0
\mathcode43="202B \mathcode61="303D
\thinmuskip=3mu
\medmuskip=4mu plus 2mu minus 4mu
\thickmuskip=5mu plus 5mu
\font\rm=cmr10 \font\sevenrm=cmr7 \font\fiverm=cmr5
\font\mi=cmmi10 \font\sevenmi=cmmi7 \font\fivemi=cmmi5
\font\sy=cmsy10 \font\sevensy=cmsy7 \font\fivesy=cmsy5
\font\ex=cmex10
\textfont2=\sy \scriptfont2=\sevensy \scriptscriptfont2=\fivesy
\textfont3=\ex \scriptfont3=\ex \scriptscriptfont3=\ex
\textfont0=\rm \scriptfont0=\sevenrm \scriptscriptfont0=\fiverm
\textfont1=\mi \scriptfont1=\sevenmi \scriptscriptfont1=\fivemi
\rm
${traceParagraph ? String.raw`\tracingparagraphs=1` : ''}
\shipout\vbox{\noindent
${text}
\par}
\end
`;
}

const CONFIG = `TEXMF = /
TEXINPUTS = .
TEXFONTMAPS = .
TFMFONTS = .
T1FONTS = .
openin_any = p
openout_any = p
`;
const FONT_MAP = FONT_NAMES.map(font => `${font} ${font.toUpperCase()} <${font}.pfb`).join('\n') + '\n';

async function verifyEnglishPatterns(bytes) {
  if (!(bytes instanceof Uint8Array) || !globalThis.crypto?.subtle) return false;
  try {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') === HYPHEN_SHA256;
  } catch {
    return false;
  }
}

export function createParagraphRuntime({ factory, wasmModule, assets, requireFirstPass = false, useEnglishPatterns = false }) {
  const patternCheck = useEnglishPatterns ? verifyEnglishPatterns(assets.get(HYPHEN_ASSET)) : null;
  return {
    async typeset(paragraph) {
      if (patternCheck && !await patternCheck) throw new Error('Pinned English hyphenation patterns are unavailable');
      const logs = [];
      const mod = await factory({
        thisProgram: '/bin/pdftex',
        noInitialRun: true,
        noExitRuntime: true,
        instantiateWasm(imports, callback) {
          const instance = new WebAssembly.Instance(wasmModule, imports);
          callback(instance);
          return instance.exports;
        },
        print: line => logs.push(line),
        printErr: line => logs.push(line),
      });
      const { FS, ENV } = mod;
      FS.mkdir('/bin');
      FS.writeFile('/bin/pdftex', '');
      FS.writeFile('/texmf.cnf', CONFIG);
      FS.writeFile('/pdftex.map', FONT_MAP);
      for (const [path, bytes] of assets) FS.writeFile(path, bytes);
      Object.assign(ENV, {
        TEXMFCNF: '/',
        TEXMF: '/',
        TEXINPUTS: '.',
        TEXFONTMAPS: '.',
        TFMFONTS: '.',
        T1FONTS: '.',
        SOURCE_DATE_EPOCH: '1577836800',
      });
      FS.writeFile('/paragraph.tex', makeParagraphSource(paragraph, { traceParagraph: requireFirstPass || useEnglishPatterns, useEnglishPatterns }));
      const status = mod.callMain(['pdftex', '--ini', '--no-shell-escape', '--interaction=nonstopmode',
        '--halt-on-error', '--jobname=paragraph', '/paragraph.tex']);
      mod._flush_streams();
      if (status !== 0) throw new Error(logs.join('\n'));
      if (requireFirstPass || useEnglishPatterns) {
        const transcript = FS.readFile('/paragraph.log', { encoding: 'utf8' });
        if ((transcript.match(/@firstpass/g) || []).length !== 1 ||
            /@emergencypass|Overfull \\hbox|Missing character:/.test(transcript) ||
            (requireFirstPass && /@secondpass/.test(transcript))) {
          throw new Error('Paragraph requires full TeX line breaking');
        }
      }
      return FS.readFile('/paragraph.pdf');
    },
  };
}
