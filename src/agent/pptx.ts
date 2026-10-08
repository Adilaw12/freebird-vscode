// src/agent/pptx.ts — builds a real, editable .pptx from a structured deck spec.
// No dependencies: the file is assembled with the zip writer in ./zip.ts.
// The model supplies content ("what goes on each slide"); layout, sizing, colour and
// OOXML are handled here deterministically, so a whole deck costs one short tool call
// instead of thousands of tokens of hand-written XML.

import { writeZip, ZipEntry } from './zip';

export interface DeckTheme {
    primary?: string;     // hex without '#', dark colour used for title slides and headings
    accent?: string;      // hex, highlight colour
    text?: string;        // hex, body text
    font?: string;        // e.g. "Calibri"
}

export type SlideLayout = 'title' | 'section' | 'bullets' | 'two-column' | 'image' | 'quote' | 'stats' | 'closing';

export interface SlideSpec {
    layout?: SlideLayout;
    title?: string;
    subtitle?: string;
    bullets?: string[];
    leftTitle?: string;
    left?: string[];
    rightTitle?: string;
    right?: string[];
    /** Resolved image bytes (the tool reads the workspace file). */
    image?: { data: Buffer; ext: 'png' | 'jpeg' | 'gif' };
    caption?: string;
    quote?: string;
    attribution?: string;
    stats?: { value: string; label: string }[];
    notes?: string;
}

export interface DeckSpec {
    title: string;
    author?: string;
    theme?: DeckTheme;
    slides: SlideSpec[];
}

const W = 40 / 3; // 12192000 EMU exactly
const H = 7.5;
const EMU = 914400;
const e = (inches: number) => Math.round(inches * EMU);

export function esc(s: string): string {
    return s
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hex(v: string | undefined, fallback: string): string {
    const m = (v ?? '').replace('#', '').trim();
    return /^[0-9a-fA-F]{6}$/.test(m) ? m.toUpperCase() : fallback;
}

interface Palette { primary: string; accent: string; text: string; muted: string; light: string; font: string }

function palette(t?: DeckTheme): Palette {
    return {
        primary: hex(t?.primary, '1F3A5F'),
        accent: hex(t?.accent, 'E8821E'),
        text: hex(t?.text, '1E2933'),
        muted: '5B6B7A',
        light: 'F3F6FA',
        font: (t?.font ?? 'Calibri').replace(/[^\w \-]/g, '') || 'Calibri'
    };
}

// ── text fitting ─────────────────────────────────────────────────────────────

/** Largest font size (pt) at which `lines` wrapped into a w x h inch box still fit. */
function fitSize(items: string[], w: number, h: number, sizes: number[], lineGap = 1.25, paraGap = 0.4): number {
    for (const sz of sizes) {
        const charsPerLine = Math.max(8, Math.floor((w * 72) / (sz * 0.52)));
        let heightPt = 0;
        for (const it of items) {
            const lines = Math.max(1, Math.ceil(it.length / charsPerLine));
            heightPt += lines * sz * lineGap + sz * paraGap;
        }
        if (heightPt <= h * 72) return sz;
    }
    return sizes[sizes.length - 1];
}

// ── XML builders ─────────────────────────────────────────────────────────────

interface RunOpts { sz: number; color: string; font: string; bold?: boolean; italic?: boolean }

function runs(text: string, o: RunOpts): string {
    // **double asterisks** mark bold inside a line.
    return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(part => {
        const bold = part.startsWith('**') && part.endsWith('**') && part.length > 4;
        const t = bold ? part.slice(2, -2) : part;
        return `<a:r><a:rPr lang="en-US" sz="${Math.round(o.sz * 100)}" b="${o.bold || bold ? 1 : 0}" i="${o.italic ? 1 : 0}" dirty="0">` +
            `<a:solidFill><a:srgbClr val="${o.color}"/></a:solidFill>` +
            `<a:latin typeface="${esc(o.font)}"/><a:cs typeface="${esc(o.font)}"/></a:rPr><a:t>${esc(t)}</a:t></a:r>`;
    }).join('');
}

interface ParaOpts extends RunOpts { align?: 'l' | 'ctr' | 'r'; bullet?: boolean; level?: number; spaceAfter?: number }

function para(text: string, o: ParaOpts): string {
    const lvl = o.level ?? 0;
    const bulletXml = o.bullet
        ? `<a:buClr><a:srgbClr val="${o.color === 'FFFFFF' ? 'FFFFFF' : 'E8821E'}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${lvl ? '–' : '•'}"/>`
        : '<a:buNone/>';
    const mar = o.bullet ? ` marL="${lvl ? 685800 : 342900}" indent="-${lvl ? 285750 : 342900}"` : '';
    return `<a:p><a:pPr algn="${o.align ?? 'l'}"${mar}><a:spcAft><a:spcPts val="${Math.round((o.spaceAfter ?? o.sz * 0.4) * 100)}"/></a:spcAft>${bulletXml}</a:pPr>` +
        `${runs(text, o)}</a:p>`;
}

function bulletParas(items: string[], sz: number, p: Palette, color: string): string {
    return items.map(raw => {
        const sub = /^(\s{2,}|\t|- )/.test(raw);
        const t = raw.replace(/^(\s+|- )/, '');
        return para(t, { sz: sub ? sz * 0.85 : sz, color, font: p.font, bullet: true, level: sub ? 1 : 0 });
    }).join('');
}

class SlideBuilder {
    private shapes: string[] = [];
    private nextId = 2;
    imageRel?: { rid: string; target: string };
    bg = 'FFFFFF';

    private id() { return this.nextId++; }

    rect(x: number, y: number, w: number, h: number, fill: string): void {
        const id = this.id();
        this.shapes.push(
            `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
            `<p:spPr><a:xfrm><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/></a:xfrm>` +
            `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
            `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
        );
    }

    text(x: number, y: number, w: number, h: number, paras: string, o: { anchor?: 't' | 'ctr' | 'b'; title?: boolean; name?: string } = {}): void {
        const id = this.id();
        const ph = o.title ? '<p:ph type="title"/>' : '';
        this.shapes.push(
            `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(o.name ?? (o.title ? 'Title' : `Text ${id}`))}"/>` +
            `<p:cNvSpPr${o.title ? '><a:spLocks noGrp="1"/></p:cNvSpPr>' : ' txBox="1"/>'}<p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
            `<p:spPr><a:xfrm><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/></a:xfrm>` +
            `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
            `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${o.anchor ?? 't'}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`
        );
    }

    picture(x: number, y: number, w: number, h: number, rid: string, descr: string): void {
        const id = this.id();
        this.shapes.push(
            `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${esc(descr)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
            `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
            `<p:spPr><a:xfrm><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
        );
    }

    slideNumber(p: Palette, color: string): void {
        const id = this.id();
        this.shapes.push(
            `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slide Number"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
            `<p:spPr><a:xfrm><a:off x="${e(W - 1.4)}" y="${e(H - 0.55)}"/><a:ext cx="${e(0.8)}" cy="${e(0.3)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
            `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
            `<a:p><a:pPr algn="r"/><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US" sz="1200"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${esc(p.font)}"/></a:rPr><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>`
        );
    }

    xml(): string {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
            `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${this.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
            `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
            `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
            `${this.shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    }
}

// ── image sizing ─────────────────────────────────────────────────────────────

function imageSize(img: { data: Buffer; ext: string }): { w: number; h: number } | null {
    const b = img.data;
    try {
        if (img.ext === 'png' && b.length > 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
        if (img.ext === 'gif' && b.length > 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
        if (img.ext === 'jpeg') {
            let i = 2;
            while (i + 9 < b.length) {
                if (b[i] !== 0xff) { i++; continue; }
                const marker = b[i + 1];
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
                }
                i += 2 + b.readUInt16BE(i + 2);
            }
        }
    } catch { /* fall through */ }
    return null;
}

// ── slide layouts ────────────────────────────────────────────────────────────

const MX = 0.75; // horizontal margin

function titleBlock(s: SlideBuilder, p: Palette, title: string | undefined): void {
    s.rect(MX, 1.42, 1.1, 0.07, p.accent);
    if (!title) return;
    const sz = fitSize([title], W - 2 * MX, 0.95, [34, 30, 28, 26, 24], 1.15, 0);
    s.text(MX, 0.4, W - 2 * MX, 0.95, para(title, { sz, color: p.primary, font: p.font, bold: true }), { anchor: 'b', title: true });
}

function buildSlide(spec: SlideSpec, p: Palette, imageRid?: string): SlideBuilder {
    const s = new SlideBuilder();
    const layout: SlideLayout = spec.layout
        ?? (spec.stats?.length ? 'stats' : spec.quote ? 'quote' : spec.image ? 'image'
            : spec.left || spec.right ? 'two-column' : 'bullets');

    if (layout === 'title' || layout === 'closing' || layout === 'section') {
        s.bg = p.primary;
        s.rect(0, 0, 0.28, H, p.accent);
        const centered = layout === 'section';
        const x = centered ? 1.5 : 1.1;
        const w = W - x - 1.1;
        const title = spec.title ?? '';
        const sz = fitSize([title], w, 2.0, layout === 'section' ? [44, 40, 36, 32] : [54, 48, 44, 40, 36, 32], 1.12, 0);
        s.text(x, 2.0, w, 2.2, para(title, { sz, color: 'FFFFFF', font: p.font, bold: true, align: centered ? 'ctr' : 'l' }), { anchor: 'b', title: true });
        s.rect(centered ? W / 2 - 0.6 : x, 4.45, 1.2, 0.08, p.accent);
        if (spec.subtitle) {
            const lines = spec.subtitle.split('\n');
            const ssz = fitSize(lines, w, 1.7, [24, 22, 20, 18], 1.25, 0.3);
            s.text(x, 4.75, w, 1.8, lines.map(l => para(l, { sz: ssz, color: 'DCE4EE', font: p.font, align: centered ? 'ctr' : 'l' })).join(''));
        }
        return s;
    }

    titleBlock(s, p, spec.title);
    const bodyTop = 1.85;
    const bodyH = H - bodyTop - 0.85;

    if (layout === 'quote') {
        s.bg = p.light;
        const q = spec.quote ?? spec.title ?? '';
        const sz = fitSize([q], W - 3, 3.4, [36, 32, 28, 24, 20], 1.3, 0);
        s.text(1.5, bodyTop, W - 3, 3.6, para(`“${q}”`, { sz, color: p.primary, font: p.font, italic: true, align: 'ctr' }), { anchor: 'ctr' });
        if (spec.attribution) s.text(1.5, 5.6, W - 3, 0.6, para(`— ${spec.attribution}`, { sz: 20, color: p.muted, font: p.font, align: 'ctr' }));
    } else if (layout === 'stats') {
        const stats = (spec.stats ?? []).slice(0, 4);
        const colW = (W - 2 * MX) / Math.max(1, stats.length);
        stats.forEach((st, i) => {
            const x = MX + i * colW;
            s.text(x, 2.5, colW - 0.3, 1.4, para(st.value, { sz: fitSize([st.value], colW - 0.3, 1.4, [60, 54, 48, 40, 32], 1.1, 0), color: p.accent, font: p.font, bold: true }), { anchor: 'b' });
            s.text(x, 4.05, colW - 0.3, 1.6, para(st.label, { sz: 20, color: p.text, font: p.font }));
        });
        if (spec.bullets?.length) {
            s.text(MX, 5.75, W - 2 * MX, 0.9, para(spec.bullets.join('  ·  '), { sz: 16, color: p.muted, font: p.font }));
        }
    } else if (layout === 'image' && spec.image && imageRid) {
        const capH = spec.caption ? 0.55 : 0;
        const boxW = W - 2 * MX;
        const boxH = bodyH - capH;
        const dim = imageSize(spec.image) ?? { w: 16, h: 9 };
        const scale = Math.min(boxW / dim.w, boxH / dim.h);
        const w = dim.w * scale, h = dim.h * scale;
        s.picture(MX + (boxW - w) / 2, bodyTop + (boxH - h) / 2, w, h, imageRid, spec.caption ?? spec.title ?? 'image');
        if (spec.caption) s.text(MX, bodyTop + boxH + 0.1, boxW, capH, para(spec.caption, { sz: 16, color: p.muted, font: p.font, italic: true, align: 'ctr' }));
    } else if (layout === 'two-column') {
        const colW = (W - 2 * MX - 0.5) / 2;
        const cols: [string | undefined, string[] | undefined, number][] = [[spec.leftTitle, spec.left, MX], [spec.rightTitle, spec.right, MX + colW + 0.5]];
        const all = [...(spec.left ?? []), ...(spec.right ?? [])];
        const sz = fitSize(all.map(a => a.trim()), colW - 0.4, bodyH - 0.6, [22, 20, 18, 16, 14]);
        for (const [heading, items, x] of cols) {
            let y = bodyTop;
            if (heading) {
                s.text(x, y, colW, 0.5, para(heading, { sz: sz + 2, color: p.accent, font: p.font, bold: true }));
                y += 0.6;
            }
            if (items?.length) s.text(x, y, colW, bodyH - (y - bodyTop), bulletParas(items, sz, p, p.text));
        }
    } else {
        const items = spec.bullets ?? [];
        if (spec.subtitle) {
            s.text(MX, bodyTop - 0.1, W - 2 * MX, 0.5, para(spec.subtitle, { sz: 20, color: p.muted, font: p.font, italic: true }));
        }
        const top = bodyTop + (spec.subtitle ? 0.55 : 0);
        const sz = fitSize(items.map(i => i.trim()), W - 2 * MX - 0.5, bodyTop + bodyH - top, [26, 24, 22, 20, 18, 16, 14]);
        s.text(MX, top, W - 2 * MX, bodyTop + bodyH - top, bulletParas(items, sz, p, p.text));
    }

    s.slideNumber(p, p.muted);
    return s;
}

// ── static parts ─────────────────────────────────────────────────────────────

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function rels(items: { id: string; type: string; target: string }[]): string {
    return `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        items.map(r => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"/>`).join('') + '</Relationships>';
}

function theme(p: Palette, name: string): string {
    const fill = (c: string) => `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>`;
    const font = (face: string) => `<a:latin typeface="${esc(face)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
    const ln = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;
    return `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements>` +
        `<a:clrScheme name="Freebird"><a:dk1>${fill(p.text)}</a:dk1><a:lt1>${fill('FFFFFF')}</a:lt1><a:dk2>${fill(p.primary)}</a:dk2><a:lt2>${fill(p.light)}</a:lt2>` +
        `<a:accent1>${fill(p.primary)}</a:accent1><a:accent2>${fill(p.accent)}</a:accent2><a:accent3>${fill('2E9E8F')}</a:accent3><a:accent4>${fill('7A5BC7')}</a:accent4>` +
        `<a:accent5>${fill('C94F4F')}</a:accent5><a:accent6>${fill('5B6B7A')}</a:accent6><a:hlink>${fill('1F6FD1')}</a:hlink><a:folHlink>${fill('7A5BC7')}</a:folHlink></a:clrScheme>` +
        `<a:fontScheme name="Freebird"><a:majorFont>${font(p.font)}</a:majorFont><a:minorFont>${font(p.font)}</a:minorFont></a:fontScheme>` +
        `<a:fmtScheme name="Freebird"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
        `<a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst>` +
        `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
        `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>` +
        `</a:themeElements></a:theme>`;
}

function placeholderSp(id: number, name: string, ph: string, x: number, y: number, w: number, h: number, body = ''): string {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>${body || '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</p:txBody></p:sp>`;
}

const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function lvl(n: number, sz: number, heading = false): string {
    const f = heading ? 'mj' : 'mn';
    return `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400"><a:defRPr sz="${sz}" b="${heading ? 1 : 0}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+${f}-lt"/><a:ea typeface="+${f}-ea"/><a:cs typeface="+${f}-cs"/></a:defRPr></a:lvl${n}pPr>`;
}

function master(): string {
    const styles = (sz: number) => [1, 2, 3, 4, 5].map(n => lvl(n, sz)).join('');
    return `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}` +
        placeholderSp(2, 'Title Placeholder 1', '<p:ph type="title"/>', MX, 0.4, W - 2 * MX, 0.95) +
        placeholderSp(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', MX, 1.85, W - 2 * MX, 4.8) +
        `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
        `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
        `<p:txStyles><p:titleStyle>${lvl(1, 3200, true)}</p:titleStyle>` +
        `<p:bodyStyle>${styles(2000)}</p:bodyStyle><p:otherStyle>${styles(1800)}</p:otherStyle></p:txStyles></p:sldMaster>`;
}

function layout(): string {
    return `${HEAD}<p:sldLayout ${NS} type="titleOnly" preserve="1"><p:cSld name="Title Only"><p:spTree>${GRP}` +
        placeholderSp(2, 'Title 1', '<p:ph type="title"/>', MX, 0.4, W - 2 * MX, 0.95) +
        `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function notesMaster(): string {
    return `${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}` +
        placeholderSp(2, 'Slide Image Placeholder 1', '<p:ph type="sldImg" idx="2"/>', 0.0, 0.0, 0, 0).replace('<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>', '<a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm>') +
        placeholderSp(3, 'Notes Placeholder 2', '<p:ph type="body" sz="quarter" idx="3"/>', 0, 0, 0, 0).replace('<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>', '<a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm>') +
        `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
        `<p:notesStyle>${lvl(1, 1200)}</p:notesStyle></p:notesMaster>`;
}

function notesSlide(text: string): string {
    const paras = text.split(/\n+/).filter(l => l.trim()).map(l => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(l)}</a:t></a:r></a:p>`).join('');
    return `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GRP}` +
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

// ── assembly ─────────────────────────────────────────────────────────────────

export function buildPptx(deck: DeckSpec): Buffer {
    const p = palette(deck.theme);
    const parts: ZipEntry[] = [];
    const add = (name: string, data: string | Buffer) => parts.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });

    const slides = deck.slides.length ? deck.slides : [{ layout: 'title' as const, title: deck.title }];
    const hasNotes = slides.map(s => !!s.notes?.trim());
    const anyNotes = hasNotes.some(Boolean);
    const exts = new Set<string>();
    let mediaCount = 0;

    slides.forEach((spec, i) => {
        const n = i + 1;
        const slideRels: { id: string; type: string; target: string }[] = [{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }];
        let imageRid: string | undefined;
        if (spec.image) {
            mediaCount++;
            exts.add(spec.image.ext);
            const media = `image${mediaCount}.${spec.image.ext === 'jpeg' ? 'jpeg' : spec.image.ext}`;
            add(`ppt/media/${media}`, spec.image.data);
            imageRid = 'rId2';
            slideRels.push({ id: imageRid, type: 'image', target: `../media/${media}` });
        }
        if (hasNotes[i]) slideRels.push({ id: 'rId3', type: 'notesSlide', target: `../notesSlides/notesSlide${n}.xml` });

        add(`ppt/slides/slide${n}.xml`, buildSlide(spec, p, imageRid).xml());
        add(`ppt/slides/_rels/slide${n}.xml.rels`, rels(slideRels));
        if (hasNotes[i]) {
            add(`ppt/notesSlides/notesSlide${n}.xml`, notesSlide(spec.notes!));
            add(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, rels([
                { id: 'rId1', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' },
                { id: 'rId2', type: 'slide', target: `../slides/slide${n}.xml` }
            ]));
        }
    });

    add('ppt/slideMasters/slideMaster1.xml', master());
    add('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([
        { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' }
    ]));
    add('ppt/slideLayouts/slideLayout1.xml', layout());
    add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]));
    add('ppt/theme/theme1.xml', theme(p, 'Freebird'));
    if (anyNotes) {
        add('ppt/theme/theme2.xml', theme(p, 'Freebird Notes'));
        add('ppt/notesMasters/notesMaster1.xml', notesMaster());
        add('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([{ id: 'rId1', type: 'theme', target: '../theme/theme2.xml' }]));
    }

    // presentation.xml — rIds: 1 master, 2.. slides, then notes master, then props.
    const presRels = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }];
    slides.forEach((_, i) => presRels.push({ id: `rId${i + 2}`, type: 'slide', target: `slides/slide${i + 1}.xml` }));
    let next = slides.length + 2;
    const notesRid = anyNotes ? `rId${next++}` : '';
    if (anyNotes) presRels.push({ id: notesRid, type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' });
    presRels.push({ id: `rId${next++}`, type: 'presProps', target: 'presProps.xml' });
    presRels.push({ id: `rId${next++}`, type: 'viewProps', target: 'viewProps.xml' });
    presRels.push({ id: `rId${next++}`, type: 'theme', target: 'theme/theme1.xml' });
    presRels.push({ id: `rId${next++}`, type: 'tableStyles', target: 'tableStyles.xml' });

    add('ppt/presentation.xml',
        `${HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
        (anyNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesRid}"/></p:notesMasterIdLst>` : '') +
        `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>` +
        `<p:sldSz cx="${e(W)}" cy="${e(H)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
    add('ppt/_rels/presentation.xml.rels', rels(presRels));
    add('ppt/presProps.xml', `${HEAD}<p:presentationPr ${NS}/>`);
    add('ppt/viewProps.xml', `${HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr></p:viewPr>`);
    add('ppt/tableStyles.xml', `${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);

    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    add('docProps/core.xml',
        `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>${esc(deck.title)}</dc:title><dc:creator>${esc(deck.author ?? 'Freebird AI')}</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
    add('docProps/app.xml', `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Freebird AI</Application><Slides>${slides.length}</Slides></Properties>`);

    add('_rels/.rels',
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`);

    const ct = (part: string, type: string) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
    add('[Content_Types].xml',
        `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        [...exts].map(x => `<Default Extension="${x}" ContentType="image/${x}"/>`).join('') +
        ct('ppt/presentation.xml', 'presentationml.presentation.main') +
        ct('ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster') +
        ct('ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout') +
        ct('ppt/theme/theme1.xml', 'theme') +
        ct('ppt/presProps.xml', 'presentationml.presProps') + ct('ppt/viewProps.xml', 'presentationml.viewProps') + ct('ppt/tableStyles.xml', 'presentationml.tableStyles') +
        (anyNotes ? ct('ppt/theme/theme2.xml', 'theme') + ct('ppt/notesMasters/notesMaster1.xml', 'presentationml.notesMaster') : '') +
        slides.map((_, i) => ct(`ppt/slides/slide${i + 1}.xml`, 'presentationml.slide') + (hasNotes[i] ? ct(`ppt/notesSlides/notesSlide${i + 1}.xml`, 'presentationml.notesSlide') : '')).join('') +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
        `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);

    // [Content_Types].xml must be first in the archive.
    const ctIdx = parts.findIndex(x => x.name === '[Content_Types].xml');
    const [ctPart] = parts.splice(ctIdx, 1);
    return writeZip([ctPart, ...parts]);
}
