// src/agent/zip.ts — minimal zip reader/writer on Node's built-in zlib, so reading
// .docx/.pptx/.xlsx and writing .pptx needs no bundled dependency. Handles the
// stored and deflate methods only, which covers every Office file in practice.

import * as zlib from 'zlib';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Reads every entry of a zip into memory. Throws on a file that is not a zip. */
export function readZip(buf: Buffer): Map<string, Buffer> {
    const entries = new Map<string, Buffer>();

    // End-of-central-directory record: signature 0x06054b50, within the last 64 KB.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a valid zip/Office file');

    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);

    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;

        if (name.endsWith('/')) continue;
        const lhNameLen = buf.readUInt16LE(localOffset + 26);
        const lhExtraLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lhNameLen + lhExtraLen;
        const raw = buf.subarray(start, start + compSize);
        if (method === 0) entries.set(name, Buffer.from(raw));
        else if (method === 8) entries.set(name, zlib.inflateRawSync(raw));
    }
    return entries;
}

export interface ZipEntry { name: string; data: Buffer }

export function writeZip(entries: ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const crc = crc32(e.data);
        const deflated = zlib.deflateRawSync(e.data);
        const useDeflate = deflated.length < e.data.length;
        const body = useDeflate ? deflated : e.data;
        const method = useDeflate ? 8 : 0;

        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0x0800, 6); // UTF-8 names
        lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(body.length, 18);
        lh.writeUInt32LE(e.data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        locals.push(lh, name, body);

        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0x0800, 8);
        ch.writeUInt16LE(method, 10);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(body.length, 20);
        ch.writeUInt32LE(e.data.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);

        offset += 30 + name.length + body.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}
