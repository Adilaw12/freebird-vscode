// test/documents.test.js — reading Office/PDF/image files, writing .pptx decks, the remember tool,
// and the agent loop's handling of cut-off tool calls, step limits and Stop.

require('./bootstrap');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { suite, check, checkAsync, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { writeZip, readZip } = require(path.join(OUT, 'agent/zip.js'));
const { readDocument, isSpecialDocument, looksBinary } = require(path.join(OUT, 'agent/documents.js'));
const { buildPptx } = require(path.join(OUT, 'agent/pptx.js'));
const { appendProjectMemory, readProjectMemory, MEMORY_RELATIVE_PATH } = require(path.join(OUT, 'agent/memory.js'));
const { runAgentLoop } = require(path.join(OUT, 'agent/loop.js'));
const { executeToolCall } = require(path.join(OUT, 'agent/tools.js'));
const { isPathIgnored } = require(path.join(OUT, 'agent/ignoreCheck.js'));
const vscode = require('vscode');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'freebird-docs-test-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function run() {
    const dir = tmp();
    try {
        suite('zip round-trip');
        {
            const zip = writeZip([{ name: 'a.txt', data: Buffer.from('hello hello hello hello') }, { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]) }]);
            const back = readZip(zip);
            check('both entries come back', back.size === 2);
            check('text content intact', back.get('a.txt').toString() === 'hello hello hello hello');
            check('binary content intact', back.get('dir/b.bin').equals(Buffer.from([1, 2, 3])));
            let threw = false;
            try { readZip(Buffer.from('not a zip at all, just text')); } catch { threw = true; }
            check('non-zip input throws a clear error', threw);
        }

        suite('Word, Excel documents are read as text');
        {
            const docx = path.join(dir, 'a.docx');
            fs.writeFileSync(docx, writeZip([{ name: 'word/document.xml', data: Buffer.from(
                '<w:document><w:body><w:p><w:r><w:t>Safe Roads</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">A &amp; B</w:t></w:r><w:r><w:tab/><w:t>end</w:t></w:r></w:p></w:body></w:document>') }]));
            const d = readDocument(docx);
            check('docx paragraphs extracted', d.kind === 'text' && d.text.split('\n')[0] === 'Safe Roads');
            check('docx entities decoded and runs joined', d.text.includes('A & B\tend'));

            const xlsx = path.join(dir, 'a.xlsx');
            fs.writeFileSync(xlsx, writeZip([
                { name: 'xl/workbook.xml', data: Buffer.from('<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>') },
                { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst><si><t>Item</t></si><si><t>Venue</t></si></sst>') },
                { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>10000</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>25000</v></c></row></sheetData></worksheet>') }
            ]));
            const x = readDocument(xlsx);
            check('xlsx sheet name and rows extracted', x.text.includes('Sheet: Budget') && x.text.includes('Item\t10000') && x.text.includes('Venue\t25000'));
        }

        suite('PDF text extraction (best effort)');
        {
            const content = 'BT /F1 24 Tf 72 700 Td (Safe Roads, Safe Lives) Tj 0 -30 Td [(Theme: ) -300 (Innovation)] TJ ET';
            const flate = zlib.deflateSync(Buffer.from(content));
            const pdf = Buffer.concat([
                Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + flate.length + ' /Filter /FlateDecode >>\nstream\n'),
                flate, Buffer.from('\nendstream\nendobj\n%%EOF')
            ]);
            const f = path.join(dir, 'a.pdf');
            fs.writeFileSync(f, pdf);
            const r = readDocument(f);
            check('flate-compressed PDF text recovered', r.kind === 'text' && r.text.includes('Safe Roads, Safe Lives') && r.text.includes('Innovation'));

            const scanned = path.join(dir, 'scan.pdf');
            fs.writeFileSync(scanned, Buffer.from('%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Length 4 >>\nstream\nabcd\nendstream\nendobj\n'));
            let msg = '';
            try { readDocument(scanned); } catch (e) { msg = e.message; }
            check('image-only PDF gives an actionable message, not garbage', /scanned/.test(msg) && /PNG|screenshot/i.test(msg));
        }

        suite('images come back as images; limits are explained');
        {
            const f = path.join(dir, 'flyer.png');
            fs.writeFileSync(f, PNG);
            const r = readDocument(f);
            check('png returned as image with base64 payload', r.kind === 'image' && r.mimeType === 'image/png' && r.base64 === PNG.toString('base64'));
            const big = path.join(dir, 'big.jpg');
            fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024 + 1));
            let msg = '';
            try { readDocument(big); } catch (e) { msg = e.message; }
            check('oversized image is refused with a size message', /MB/.test(msg));
            check('legacy .doc gets a "re-save as .docx" message', (() => { try { fs.writeFileSync(path.join(dir, 'o.doc'), 'x'); readDocument(path.join(dir, 'o.doc')); } catch (e) { return /\.docx/.test(e.message); } return false; })());
            check('isSpecialDocument recognises types', isSpecialDocument('a.PDF') && isSpecialDocument('x.pptx') && !isSpecialDocument('x.ts'));
            check('looksBinary spots NUL bytes', looksBinary(Buffer.from([65, 0, 66])) && !looksBinary(Buffer.from('plain text')));
        }

        suite('buildPptx makes a deck our own reader (and PowerPoint) can open');
        {
            const bytes = buildPptx({
                title: 'T', theme: { primary: '0B1F4D', accent: 'F28C28' },
                slides: [
                    { layout: 'title', title: 'Safe Roads, Safe Lives', subtitle: 'TOMRG 2026', notes: 'Welcome' },
                    { layout: 'bullets', title: 'Why it matters', bullets: ['**1.19M** deaths a year', '  sub point & more <b>'], notes: 'Cite WHO' },
                    { layout: 'image', title: 'Pic', image: { data: PNG, ext: 'png' }, caption: 'cap' },
                    { layout: 'stats', title: 'Numbers', stats: [{ value: '93%', label: 'low income' }] },
                    { layout: 'closing', title: 'Thank you' }
                ]
            });
            const entries = readZip(bytes);
            check('[Content_Types].xml present', entries.has('[Content_Types].xml'));
            check('five slide parts', [...entries.keys()].filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).length === 5);
            check('image embedded', [...entries.keys()].some(k => k.startsWith('ppt/media/')));
            check('every part is well-formed enough (no unescaped "<b>" text)', !entries.get('ppt/slides/slide2.xml').toString().includes('<b>'));
            const f = path.join(dir, 'deck.pptx');
            fs.writeFileSync(f, bytes);
            const back = readDocument(f).text;
            check('slide text round-trips', back.includes('Safe Roads, Safe Lives') && back.includes('1.19M deaths a year'));
            check('speaker notes round-trip', back.includes('[Speaker notes] Welcome') && back.includes('Cite WHO'));
            check('slide-number field is not reported as content', !back.includes('‹#›'));
        }

        suite('remember: appends without approval, dedupes, stays under the size cap');
        {
            vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
            check('first note saved', appendProjectMemory('Audience is transport academics').ok);
            check('duplicate is a no-op', /Already/.test(appendProjectMemory('audience is transport academics').message));
            check('file holds one bullet', fs.readFileSync(path.join(dir, MEMORY_RELATIVE_PATH), 'utf8').trim() === '- Audience is transport academics');
            for (let i = 0; i < 120; i++) appendProjectMemory(`Note number ${i} with some extra words to take up room in the file`);
            const mem = fs.readFileSync(path.join(dir, MEMORY_RELATIVE_PATH), 'utf8');
            check('file stays within the loaded size', mem.length <= 4000);
            check('newest note survives, oldest dropped', mem.includes('Note number 119') && !mem.includes('Audience is transport'));
            check('readProjectMemory is not truncated', !readProjectMemory().includes('truncated'));
            check('empty note rejected', appendProjectMemory('   ').ok === false);
            vscode.workspace.workspaceFolders = undefined;
            check('no workspace -> clear failure, no throw', appendProjectMemory('x').ok === false);
        }

        suite('tools: read_file handles documents, create_presentation writes a deck, remember tool works');
        {
            vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
            fs.mkdirSync(path.join(dir, '.freebird', 'uploads'), { recursive: true });
            fs.writeFileSync(path.join(dir, '.freebird', 'uploads', 'flyer.png'), PNG);
            fs.writeFileSync(path.join(dir, '.gitignore'), '.freebird/\n');
            const ctx = {};
            const approve = async () => true;
            const call = (tool, onApproval = approve) => executeToolCall(tool, {}, onApproval, ctx, 's', 'turn-docs');

            const img = await call({ action: 'read_file', path: '.freebird/uploads/flyer.png' });
            check('attached image readable even though .gitignore hides .freebird/', img.success && img.image && img.image.mimeType === 'image/png');
            check('uploads exemption does not cover secrets', isPathIgnored(dir, '.freebird/uploads/.env') && isPathIgnored(dir, '.freebird/uploads/id_rsa'));

            const missing = await call({ action: 'read_file', path: 'nope.txt' });
            check('missing file -> helpful message', !missing.success && /not found/i.test(missing.output));

            fs.writeFileSync(path.join(dir, 'lines.txt'), 'a\nb\nc\nd\n');
            const part = await call({ action: 'read_file', path: 'lines.txt', startLine: 2, endLine: 3 });
            check('line range returned with numbers', part.success && part.output.includes('2\tb') && part.output.includes('3\tc') && !part.output.includes('4\td'));

            fs.writeFileSync(path.join(dir, 'blob.dat'), Buffer.from([0, 1, 2, 0, 3]));
            const blob = await call({ action: 'read_file', path: 'blob.dat' });
            check('binary file -> explanation instead of mojibake', !blob.success && /binary/i.test(blob.output));

            let asked = '';
            const rej = await call({ action: 'create_presentation', path: 'decks/a', title: 'A', slides: [{ layout: 'title', title: 'Hello' }] }, async (_id, desc) => { asked = desc; return false; });
            check('rejection leaves no file', !rej.success && !fs.existsSync(path.join(dir, 'decks', 'a.pptx')));
            check('approval text names path and slide count', /decks\/a\.pptx \(1 slides\)/.test(asked));

            const made = await call({ action: 'create_presentation', path: 'decks/a.pptx', title: 'A', slides: [
                { layout: 'title', title: 'Hello', subtitle: 'World' },
                { layout: 'image', title: 'Pic', image: '.freebird/uploads/flyer.png', caption: 'c' },
                { layout: 'bullets', title: 'Gone', image: 'missing.png', bullets: 'one\ntwo' }
            ] });
            check('deck written', made.success && fs.existsSync(path.join(dir, 'decks', 'a.pptx')));
            check('missing image reported, not fatal', /missing\.png/.test(made.output));
            const reread = await call({ action: 'read_file', path: 'decks/a.pptx' });
            check('the model can read the deck back', reread.success && reread.output.includes('Hello') && reread.output.includes('one'));

            const noSlides = await call({ action: 'create_presentation', path: 'x.pptx', title: 'x', slides: [] });
            check('empty slide list rejected', !noSlides.success);

            const rem = await call({ action: 'remember', note: 'Deck lives in decks/a.pptx' });
            check('remember tool needs no approval and saves', rem.success && fs.readFileSync(path.join(dir, MEMORY_RELATIVE_PATH), 'utf8').includes('decks/a.pptx'));
            vscode.workspace.workspaceFolders = undefined;
        }

        suite('agent loop: cut-off tool calls, step limit, Stop');
        {
            vscode.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
            const base = (provider, extra = {}) => {
                const events = [];
                return {
                    events,
                    opts: {
                        userMessage: 'make a deck', history: [], provider, git: {}, context: {}, sessionId: 's',
                        onEvent: e => events.push(e), onApprovalNeeded: async () => true, ...extra
                    }
                };
            };

            // 1. First reply is cut off mid tool call; the loop must retry instead of ending silently.
            let calls = 0;
            const sent = [];
            const cut = { async stream(messages, onChunk) {
                calls++; sent.push(messages.map(m => m.content));
                onChunk(calls === 1 ? 'Plan.\n```tool\n{"action":"write_file","path":"a.txt","content":"xxxxxxxx' : 'Done in smaller pieces.');
            } };
            let t = base(cut);
            let hist = await runAgentLoop(t.opts);
            check('provider called a second time after the cut-off reply', calls === 2);
            check('the retry message tells the model what happened', sent[1].some(c => /cut off/.test(c) && /create_presentation/.test(c)));
            check('final answer reaches the user', hist[hist.length - 1].content === 'Done in smaller pieces.');
            check('a status event explains the retry', t.events.some(e => e.type === 'status' && /cut off/.test(e.text)));
            check('nothing was written by the half call', !fs.existsSync(path.join(dir, 'a.txt')));

            // 2. Cut off every time -> a clear message, not silence.
            const alwaysCut = { async stream(_m, onChunk) { onChunk('```tool\n{"action":"write_file","path":"b.txt","content":"zz'); } };
            t = base(alwaysCut);
            hist = await runAgentLoop(t.opts);
            const last = hist[hist.length - 1].content;
            check('repeated cut-offs end with an explanation', /smaller pieces|running out of room/i.test(last));

            // 3. Step limit is announced.
            const looping = { async stream(_m, onChunk) { onChunk('```tool\n{"action":"list_files","pattern":"*.txt"}\n```'); } };
            t = base(looping, { maxIterations: 2 });
            hist = await runAgentLoop(t.opts);
            check('step limit message offered', /Paused after 2 steps/.test(hist[hist.length - 1].content));

            // 4. Empty reply is reported.
            t = base({ async stream() { /* nothing */ } });
            hist = await runAgentLoop(t.opts);
            check('empty reply is reported, not silent', /empty reply/i.test(hist[hist.length - 1].content));

            // 5. Stop.
            const ctl = new AbortController();
            ctl.abort();
            t = base({ async stream() { throw new Error('should not be called'); } }, { signal: ctl.signal });
            hist = await runAgentLoop(t.opts);
            check('already-stopped run says Stopped and never calls the model', hist[hist.length - 1].content === 'Stopped.');

            const ctl2 = new AbortController();
            const aborting = { async stream(_m, _c, o) { ctl2.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e; } };
            t = base(aborting, { signal: ctl2.signal });
            hist = await runAgentLoop(t.opts);
            check('abort mid-request ends cleanly with Stopped', hist[hist.length - 1].content === 'Stopped.');
            vscode.workspace.workspaceFolders = undefined;
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
