// src/agent/documents.ts — lets read_file understand more than UTF-8 text:
// images come back as a real image the model can look at, and Word / PowerPoint /
// Excel / PDF files come back as extracted text. Pure Node (no vscode import) so it
// is unit-testable and has no bundled dependencies.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { readZip } from './zip';

export type DocumentResult =
    | { kind: 'text'; text: string; note?: string }
    | { kind: 'image'; mimeType: string; base64: string; note: string };

const IMAGE_TYPES: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp'
};

// The cloud backend sits behind a 4.5 MB request limit, and base64 inflates by a third.
export const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

const OFFICE_EXTS = new Set(['.docx', '.pptx', '.xlsx']);
const LEGACY_OFFICE_EXTS = new Set(['.doc', '.ppt', '.xls']);

/** True for files read_file handles specially instead of as UTF-8 text. */
export function isSpecialDocument(file: string): boolean {
    const ext = path.extname(file).toLowerCase();
    return ext in IMAGE_TYPES || OFFICE_EXTS.has(ext) || LEGACY_OFFICE_EXTS.has(ext) || ext === '.pdf';
}

export function readDocument(fullPath: string): DocumentResult {
    const ext = path.extname(fullPath).toLowerCase();
    const buf = fs.readFileSync(fullPath);
    const name = path.basename(fullPath);

    if (ext in IMAGE_TYPES) {
        if (buf.length > MAX_IMAGE_BYTES) {
            throw new Error(
                `${name} is ${(buf.length / 1048576).toFixed(1)} MB — images over ${MAX_IMAGE_BYTES / 1048576} MB can't be sent to the model. ` +
                `Ask the user to export a smaller copy (e.g. a screenshot or a resized JPEG).`
            );
        }
        return {
            kind: 'image',
            mimeType: IMAGE_TYPES[ext],
            base64: buf.toString('base64'),
            note: `Image ${name} (${Math.round(buf.length / 1024)} KB) is attached — look at it and read any text in it directly.`
        };
    }

    if (LEGACY_OFFICE_EXTS.has(ext)) {
        throw new Error(
            `${name} is an old binary Office format (${ext}) that can't be read directly. ` +
            `Ask the user to re-save it as ${ext === '.doc' ? '.docx' : ext === '.ppt' ? '.pptx' : '.xlsx'}.`
        );
    }

    if (ext === '.docx') return { kind: 'text', text: docxText(buf) };
    if (ext === '.pptx') return { kind: 'text', text: pptxText(buf) };
    if (ext === '.xlsx') return { kind: 'text', text: xlsxText(buf) };
    if (ext === '.pdf') return pdfText(buf, name);

    throw new Error(`${name} is not a supported document type.`);
}

/** Cheap check for binary content in files with an unrecognised extension. */
export function looksBinary(buf: Buffer): boolean {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
}

// ── XML helpers ──────────────────────────────────────────────────────────────

export function decodeXml(s: string): string {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}

function text(entries: Map<string, Buffer>, name: string): string {
    return entries.get(name)?.toString('utf8') ?? '';
}

/** Paragraph-aware text from WordprocessingML / DrawingML: <w:p>/<a:p> blocks holding <w:t>/<a:t> runs. */
function paragraphs(xml: string, para: 'w:p' | 'a:p', run: 'w:t' | 'a:t'): string[] {
    const out: string[] = [];
    const paraRe = new RegExp(`<${para}[ >][\\s\\S]*?</${para}>`, 'g');
    const tokenRe = new RegExp(`<${run}(?: [^>]*)?>([\\s\\S]*?)</${run}>|<(?:w:tab|a:tab)\\s*/>|<(?:w:br|a:br)\\s*/?>`, 'g');
    for (const p of xml.match(paraRe) ?? []) {
        let line = '';
        let m: RegExpExecArray | null;
        tokenRe.lastIndex = 0;
        while ((m = tokenRe.exec(p))) {
            if (m[1] !== undefined) line += decodeXml(m[1]);
            else line += m[0].includes('br') ? '\n' : '\t';
        }
        if (line.trim() && line.trim() !== '‹#›') out.push(line);
    }
    return out;
}

function numericSort(a: string, b: string): number {
    const na = parseInt(a.match(/(\d+)\.xml$/)?.[1] ?? '0', 10);
    const nb = parseInt(b.match(/(\d+)\.xml$/)?.[1] ?? '0', 10);
    return na - nb;
}

function docxText(buf: Buffer): string {
    const entries = readZip(buf);
    const body = paragraphs(text(entries, 'word/document.xml'), 'w:p', 'w:t');
    if (body.length === 0) throw new Error('No text found in this Word document.');
    return body.join('\n');
}

function pptxText(buf: Buffer): string {
    const entries = readZip(buf);
    const slides = [...entries.keys()].filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort(numericSort);
    if (slides.length === 0) throw new Error('No slides found in this PowerPoint file.');
    const out: string[] = [];
    slides.forEach((name, i) => {
        const n = name.match(/slide(\d+)\.xml$/)![1];
        out.push(`--- Slide ${i + 1} ---`);
        out.push(...paragraphs(text(entries, name), 'a:p', 'a:t'));
        const notes = paragraphs(text(entries, `ppt/notesSlides/notesSlide${n}.xml`), 'a:p', 'a:t')
            .filter(l => !/^\d+$/.test(l.trim()));
        if (notes.length) out.push(`[Speaker notes] ${notes.join(' ')}`);
    });
    return out.join('\n');
}

function xlsxText(buf: Buffer): string {
    const entries = readZip(buf);

    const shared: string[] = [];
    for (const si of text(entries, 'xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) ?? []) {
        shared.push([...si.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join(''));
    }

    const sheetNames = [...text(entries, 'xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(m => decodeXml(m[1]));
    const sheets = [...entries.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort(numericSort);
    if (sheets.length === 0) throw new Error('No worksheets found in this Excel file.');

    const MAX_ROWS = 500;
    const out: string[] = [];
    sheets.forEach((name, i) => {
        out.push(`--- Sheet: ${sheetNames[i] ?? `Sheet${i + 1}`} ---`);
        let rows = 0;
        for (const row of text(entries, name).match(/<row[ >][\s\S]*?<\/row>/g) ?? []) {
            if (rows++ >= MAX_ROWS) { out.push(`… (more than ${MAX_ROWS} rows, truncated)`); break; }
            const cells: string[] = [];
            for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
                const type = c.match(/ t="([^"]*)"/)?.[1];
                const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
                const inline = c.match(/<is>[\s\S]*?<\/is>/)?.[0];
                let value = '';
                if (type === 's' && v !== undefined) value = shared[parseInt(v, 10)] ?? '';
                else if (inline) value = [...inline.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');
                else if (v !== undefined) value = decodeXml(v);
                cells.push(value);
            }
            if (cells.some(c => c !== '')) out.push(cells.join('\t'));
        }
    });
    return out.join('\n');
}

// ── PDF (best effort, no dependencies) ───────────────────────────────────────
// Handles ordinary text PDFs: inflates content streams and reads the text-showing
// operators. Scanned PDFs (pictures of pages) have no text to extract, and fonts
// with custom encodings can come out scrambled — both are reported honestly.

function pdfString(raw: string): string {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch !== '\\') { out += ch; continue; }
        const next = raw[++i];
        if (next === 'n') out += '\n';
        else if (next === 'r' || next === 't' || next === 'b' || next === 'f') out += ' ';
        else if (next === '(' || next === ')' || next === '\\') out += next;
        else if (next >= '0' && next <= '7') {
            let oct = next;
            while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
            out += String.fromCharCode(parseInt(oct, 8));
        } else if (next !== '\n' && next !== '\r') out += next;
    }
    return out;
}

function pdfHex(hex: string): string {
    const clean = hex.replace(/\s+/g, '');
    let out = '';
    // 4-hex-digit codes are usually UTF-16 glyph ids/unicode; 2-digit are bytes.
    if (clean.length % 4 === 0 && /^00/.test(clean)) {
        for (let i = 0; i < clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    } else {
        for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
    }
    return out;
}

function pdfText(buf: Buffer, name: string): DocumentResult {
    const latin = buf.toString('latin1');
    const pages: string[] = [];
    const streamRe = /<<([\s\S]{0,800}?)>>\s*stream\r?\n/g;
    let m: RegExpExecArray | null;

    while ((m = streamRe.exec(latin))) {
        const dict = m[1];
        const start = streamRe.lastIndex;
        const end = latin.indexOf('endstream', start);
        if (end < 0) break;
        streamRe.lastIndex = end;
        if (/\/Subtype\s*\/(Image|Form|Type1C|CIDFontType0C)/.test(dict) || /\/Type\s*\/(XRef|ObjStm|Metadata)/.test(dict)) continue;

        let data: Buffer = buf.subarray(start, end);
        if (/\/FlateDecode/.test(dict)) {
            try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateRawSync(data.subarray(2)); } catch { continue; } }
        }
        const content = data.toString('latin1');
        if (!/\bBT\b/.test(content)) continue;

        let pageText = '';
        for (const block of content.match(/BT[\s\S]*?ET/g) ?? []) {
            const ops = block.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|\[(?:\\.|[^\]])*\]\s*TJ|<[0-9a-fA-F\s]+>\s*Tj|\bT\*|\bTd\b|\bTD\b|\bTm\b|\bET\b/g);
            for (const op of ops) {
                const s = op[0];
                if (/^(T\*|Td|TD|Tm)$/.test(s)) { if (!pageText.endsWith('\n')) pageText += '\n'; continue; }
                if (s.endsWith('Tj') && s.startsWith('(')) pageText += pdfString(s.slice(1, s.lastIndexOf(')')));
                else if (s.endsWith('Tj')) pageText += pdfHex(s.slice(1, s.indexOf('>')));
                else if (s.endsWith('TJ')) {
                    for (const part of s.slice(1, s.lastIndexOf(']')).matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]+)>|(-?\d+(?:\.\d+)?)/g)) {
                        if (part[1] !== undefined) pageText += pdfString(part[1]);
                        else if (part[2] !== undefined) pageText += pdfHex(part[2]);
                        else if (parseFloat(part[3]) < -200) pageText += ' ';
                    }
                }
            }
            pageText += '\n';
        }
        if (pageText.trim()) pages.push(pageText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    }

    const joined = pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join('\n\n');
    const printable = joined.replace(/[^\x20-\x7e\n]/g, '').length;
    if (!joined || printable < joined.length * 0.6 || printable < 20) {
        throw new Error(
            `Couldn't extract readable text from ${name} — it is probably scanned (pictures of pages) or uses embedded fonts. ` +
            `Ask the user to attach screenshots of the pages (PNG/JPG) or paste the text.`
        );
    }
    return { kind: 'text', text: joined, note: 'PDF text was extracted without layout; tables and columns may be out of order.' };
}
