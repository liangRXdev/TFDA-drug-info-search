/**
 * 測試用檔案產生器：真正的 ZIP／XLSX（deflate、CRC32）與 Big5 編碼。
 * 只產生合成資料；真實院內藥檔不進 repo。
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files：[{ name, data: string|Buffer, method?: 0|8, flags?: number }]
export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf-8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf-8');
    const method = f.method ?? 8;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const flags = f.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * sheets：[{ file: 'sheet2.xml', rows: [[cell, ...], ...] }]，陣列順序＝工作簿宣告順序（第一個即「第一張工作表」）。
 * cell：字串（偶數欄走 sharedStrings、奇數欄走 inlineStr，兩種路徑都測到）、
 *       null／'' 代表略過該儲存格（稀疏）、{ f, v } 為帶已存結果的公式字串。
 */
export function buildXlsx(sheets, { method = 8 } = {}) {
  const shared = [];
  const sharedIndex = s => {
    let i = shared.indexOf(s);
    if (i === -1) { shared.push(s); i = shared.length - 1; }
    return i;
  };
  const sheetXml = rows => {
    const body = rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (cell === null || cell === '' || cell === undefined) return '';
        const ref = `${colName(c)}${r + 1}`;
        if (typeof cell === 'object') return `<c r="${ref}" t="str"><f>${esc(cell.f)}</f><v>${esc(cell.v)}</v></c>`;
        if (c % 2 === 0) return `<c r="${ref}" t="s"><v>${sharedIndex(String(cell))}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  };

  const sheetFiles = sheets.map(s => ({ name: `xl/worksheets/${s.file}`, data: sheetXml(s.rows) }));
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    sheets.map((s, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`).join('')}</Relationships>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
    shared.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;

  return buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    ...sheetFiles,
    { name: 'xl/sharedStrings.xml', data: sst },
  ].map(f => ({ ...f, method })));
}

// Node 的 TextDecoder 能解 Big5 但無編碼器：解碼所有雙位元組碼位後反查
let big5Map = null;
export function encodeBig5(str) {
  if (!big5Map) {
    big5Map = new Map();
    const dec = new TextDecoder('big5');
    for (let lead = 0x81; lead <= 0xfe; lead += 1) {
      for (const [lo, hi] of [[0x40, 0x7e], [0xa1, 0xfe]]) {
        for (let trail = lo; trail <= hi; trail += 1) {
          const ch = dec.decode(new Uint8Array([lead, trail]));
          if (ch.length === 1 && ch !== '�' && !big5Map.has(ch)) big5Map.set(ch, [lead, trail]);
        }
      }
    }
  }
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else {
      const pair = big5Map.get(ch);
      if (!pair) throw new Error(`Big5 無法編碼：${ch}`);
      out.push(...pair);
    }
  }
  return Buffer.from(out);
}

export const toArrayBuffer = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
