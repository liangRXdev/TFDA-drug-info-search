// 院內清單：解析、正規化、K1–K4 分類（規格：docs/plan-formulary-share.md）
//
// 本檔為 classic script，只掛一個全域物件 TFDAFormulary；同一份程式在頁面與 node --test 共用。
// 全部是純函式（儲存層除外），不碰 DOM。清單只存在使用者瀏覽器，不會上傳。
//
// CSV／XLSX 解析段移植自 liangRXdev/oe-extension 的 src/formulary.js（該檔又移植自
// LCCtaiwan/oe-extension feature/hospital-formulary），依其 MIT 授權保留以下聲明：
//
//   MIT License
//   Copyright (c) 2026 Hsieh-Ting Lin
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// 與來源的差異：不移植模糊比對與同成分／同 ATC 面板；新增健保代號、許可證字號欄；
// 只保存六個欄位（價格、儲位、ATC 等不保存）；ZIP 讀取加上邊界與 ZIP64 檢查。

(function (root) {
    'use strict';

    const MAX_FILE_BYTES = 5 * 1024 * 1024;   // 含：恰好 5 MB 可匯入
    const MAX_ROWS = 20000;                   // 含：表頭後的非空白列數上限
    const HEADER_SEARCH_ROWS = 20;            // 表頭須在前 20 個非空白列內
    const STALE_DAYS = 90;                    // 匯入經過天數警示門檻（只警示不停用）
    const UNMATCHED_LIMIT = 20;               // 未對應區塊最多列出筆數
    const UNMATCHED_MIN_CHARS = 2;

    // 表頭別名：比對前去空白、轉小寫
    const COLUMN_ALIASES = {
        code:       ['批價碼', '院內代碼', '院內碼', '藥品代碼', '藥碼', '代碼', 'code'],
        name:       ['藥名', '品名', '藥品名稱', '藥品名', '中文品名', 'name', 'drugname'],
        enName:     ['英文品名', '英文名稱', '英文藥名', 'englishname', 'enname'],
        ingredient: ['成分', '主成分', '成分名', 'ingredient', 'ingredients'],
        nhiCode:    ['健保代號', '健保碼', '健保代碼', '健保藥品代號', '健保藥碼', 'nhicode', 'nhi'],
        license:    ['許可證字號', '許可證', '許可證號', '藥品許可證', 'license', 'licenseno'],
    };
    const STORED_FIELDS = ['code', 'name', 'enName', 'ingredient', 'nhiCode', 'license'];

    class FormularyError extends Error {}

    // ── 正規化 ────────────────────────────────────────────────
    function cleanCell(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    const nfkc = v => String(v ?? '').normalize('NFKC');

    function normalizeHeader(value) {
        return nfkc(value).replace(/\s+/g, '').toLowerCase();
    }

    // 健保代號：NFKC、去所有空白、轉大寫；須為 10 碼英數，否則視為空（不做前綴或去符號比對）
    function normalizeNhiCode(value) {
        const s = nfkc(value).replace(/\s+/g, '').toUpperCase();
        return /^[A-Z0-9]{10}$/.test(s) ? s : '';
    }

    // 許可證字號：NFKC、去所有空白、去掉**末尾一個**「號」（HIS 匯出常省略；數字仍完整比對，
    // 不會讓兩張不同許可證相撞）。不去「第」、不去符號、不去前導零
    function normalizeLicense(value) {
        return nfkc(value).replace(/\s+/g, '').replace(/號$/, '');
    }

    // 沒有許可證表頭時，以內容辨識：某欄過半數非空值形如「…字第＋數字（＋號）」
    const LICENSE_VALUE_RE = /^[一-鿿]{1,10}字第\d+號?$/;
    const LICENSE_DETECT_RATIO = 0.5;

    // 院內碼去重鍵：NFKC、去空白、轉大寫；空碼不參與去重
    function normalizeInnerCode(value) {
        return nfkc(value).replace(/\s+/g, '').toUpperCase();
    }

    // 名稱與關鍵字：NFKC、轉小寫、連續空白併一、去頭尾
    function normalizeText(value) {
        return nfkc(value).toLowerCase().replace(/\s+/g, ' ').trim();
    }

    // ── CSV ───────────────────────────────────────────────────
    // RFC 4180：引號欄位、雙引號跳脫、CRLF／LF、欄內換行
    function parseCsv(text) {
        const source = String(text || '').replace(/^﻿/, '');
        const rows = [];
        let row = [], field = '', quoted = false;
        for (let i = 0; i < source.length; i += 1) {
            const ch = source[i];
            if (quoted) {
                if (ch === '"') {
                    if (source[i + 1] === '"') { field += '"'; i += 1; }
                    else quoted = false;
                } else field += ch;
                continue;
            }
            if (ch === '"') quoted = true;
            else if (ch === ',') { row.push(field); field = ''; }
            else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && source[i + 1] === '\n') i += 1;
                row.push(field); rows.push(row); row = []; field = '';
            } else field += ch;
        }
        if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
        return rows.filter(cells => cells.some(c => cleanCell(c)));
    }

    // HIS 匯出常為 Big5：UTF-8 解碼出現替代字元時改用 Big5
    function decodeText(buffer) {
        const bytes = new Uint8Array(buffer);
        const utf8 = new TextDecoder('utf-8').decode(bytes);
        if (!utf8.includes('�')) return utf8;
        try { return new TextDecoder('big5', { fatal: true }).decode(bytes); }
        catch { throw new FormularyError('無法辨識檔案編碼（僅支援 UTF-8 與 Big5）'); }
    }

    // ── XLSX（最小 ZIP 讀取：stored／deflate，不支援 ZIP64）────
    function unescapeXml(value) {
        return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_m, hex, dec, named) => {
            if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
            if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
            return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()];
        });
    }

    // 串接所有 <t>，略過注音（<rPh>）
    function textOfRuns(xml) {
        const plain = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
        let text = '';
        for (const m of plain.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(m[1]);
        return text;
    }

    function columnIndex(ref) {
        const letters = (ref.match(/^[A-Z]+/i) || [''])[0].toUpperCase();
        let index = 0;
        for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
        return index - 1;
    }

    async function inflateRaw(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    const BAD_XLSX = 'XLSX 檔損毀或不完整';

    async function readZipEntries(buffer) {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const u16 = o => { if (o + 2 > bytes.length) throw new FormularyError(BAD_XLSX); return view.getUint16(o, true); };
        const u32 = o => { if (o + 4 > bytes.length) throw new FormularyError(BAD_XLSX); return view.getUint32(o, true); };

        let eocd = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd === -1) throw new FormularyError(BAD_XLSX + '（找不到 ZIP 目錄）');

        const entryCount = u16(eocd + 10);
        let offset = u32(eocd + 16);
        if (entryCount === 0xffff || offset === 0xffffffff) throw new FormularyError('不支援 ZIP64 格式的 XLSX');

        const decoder = new TextDecoder('utf-8');
        const entries = new Map();
        for (let n = 0; n < entryCount; n += 1) {
            if (u32(offset) !== 0x02014b50) throw new FormularyError(BAD_XLSX + '（目錄損毀）');
            const flags = u16(offset + 8);
            const method = u16(offset + 10);
            const compressedSize = u32(offset + 20);
            const nameLength = u16(offset + 28);
            const extraLength = u16(offset + 30);
            const commentLength = u16(offset + 32);
            const localOffset = u32(offset + 42);
            if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new FormularyError('不支援 ZIP64 格式的 XLSX');
            if (offset + 46 + nameLength > bytes.length) throw new FormularyError(BAD_XLSX);
            const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            entries.set(name, { flags, method, compressedSize, localOffset });
            offset += 46 + nameLength + extraLength + commentLength;
        }

        return {
            names: [...entries.keys()],
            async read(name) {
                const entry = entries.get(name);
                if (!entry) return null;
                if (entry.flags & 0x1) throw new FormularyError('不支援加密的 XLSX');
                const local = entry.localOffset;
                if (u32(local) !== 0x04034b50) throw new FormularyError(BAD_XLSX);
                const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
                const dataEnd = dataStart + entry.compressedSize;
                // 截斷的檔案：subarray 會靜默截短，必須明確拒絕，不可接受部分內容
                if (dataEnd > bytes.length) throw new FormularyError(BAD_XLSX);
                const data = bytes.subarray(dataStart, dataEnd);
                let raw;
                if (entry.method === 0) raw = data;
                else if (entry.method === 8) {
                    try { raw = await inflateRaw(data); }
                    catch { throw new FormularyError(BAD_XLSX); }
                } else throw new FormularyError(`不支援的壓縮方式 (${entry.method})`);
                return decoder.decode(raw);
            },
        };
    }

    function resolveZipPath(target) {
        const cleaned = target.replace(/^\/+/, '');
        return cleaned.startsWith('xl/') ? cleaned : `xl/${cleaned}`;
    }

    // 回傳工作簿宣告的第一張工作表；公式儲存格取檔內已存的計算結果（<v>）
    async function readXlsxRows(buffer) {
        const zip = await readZipEntries(buffer);
        const workbook = await zip.read('xl/workbook.xml');
        const rels = await zip.read('xl/_rels/workbook.xml.rels');
        if (!workbook || !rels) throw new FormularyError(BAD_XLSX + '（缺少活頁簿資訊）');

        const firstSheet = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"/);
        const relMatch = firstSheet && [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)]
            .find(m => new RegExp(`\\bId="${firstSheet[1]}"`).test(m[1]));
        const target = relMatch?.[1].match(/Target="([^"]+)"/)?.[1];
        const sheet = target ? await zip.read(resolveZipPath(target)) : null;
        if (!sheet) throw new FormularyError('XLSX 檔裡找不到第一張工作表');

        const sharedXml = (await zip.read('xl/sharedStrings.xml')) || '';
        const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => textOfRuns(m[1]));

        const rows = [];
        for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
            const cells = [];
            for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                const attrs = cellMatch[1];
                const body = cellMatch[2] || '';
                const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1];
                const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
                const index = ref ? columnIndex(ref) : cells.length;
                let value = '';
                if (type === 'inlineStr') value = textOfRuns(body);
                else {
                    const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
                    if (raw !== undefined) value = type === 's' ? shared[Number.parseInt(raw, 10)] || '' : unescapeXml(raw);
                }
                cells[index] = value;
            }
            rows.push(Array.from(cells, c => (c === undefined ? '' : c)));
        }
        return rows.filter(cells => cells.some(c => cleanCell(c)));
    }

    // ── 表頭偵測與資料列處理 ───────────────────────────────────
    function detectColumns(rows) {
        const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
        for (let r = 0; r < limit; r += 1) {
            const headers = rows[r].map(normalizeHeader);
            const columns = {};
            for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
                const index = headers.findIndex(h => aliases.includes(h));
                if (index !== -1) columns[field] = index;
            }
            if (columns.name !== undefined || columns.enName !== undefined) return { headerRow: r, columns };
        }
        return null;
    }

    // rows（已去除空白列）→ { items, rawRows, excluded, hasNhiColumn, hasLicenseColumn }
    function rowsToFormulary(rows) {
        const detected = detectColumns(rows || []);
        if (!detected) throw new FormularyError(`前 ${HEADER_SEARCH_ROWS} 列內找不到「藥名」或「英文品名」欄位`);
        const { headerRow, columns } = detected;
        const dataRows = rows.slice(headerRow + 1);
        if (dataRows.length > MAX_ROWS) {
            throw new FormularyError(`資料列 ${dataRows.length.toLocaleString()} 列，超過上限 ${MAX_ROWS.toLocaleString()} 列`);
        }
        const licenseDetected = columns.license === undefined ? detectLicenseColumn(rows[headerRow], dataRows, columns) : null;
        if (licenseDetected) columns.license = licenseDetected.index;
        const cell = (row, field) => (columns[field] === undefined ? '' : cleanCell(row[columns[field]]));

        const items = [];
        const seenCodes = new Set();
        const excluded = { noName: 0, dupCode: 0 };
        for (const row of dataRows) {
            const name = cell(row, 'name');
            const enName = cell(row, 'enName');
            // 無品名但有許可證字號：保留（可能以許可證對上而取得徽章，以院內代碼顯示）；
            // 分類時若對不上，計入「無藥名」且不進未對應區塊（v6）
            if (!name && !enName && !cell(row, 'license')) { excluded.noName += 1; continue; }
            const code = cell(row, 'code');
            const codeKey = normalizeInnerCode(code);
            if (codeKey) {
                if (seenCodes.has(codeKey)) { excluded.dupCode += 1; continue; }
                seenCodes.add(codeKey);
            }
            items.push({
                code, name, enName,
                ingredient: cell(row, 'ingredient'),
                nhiCode: normalizeNhiCode(cell(row, 'nhiCode')),
                license: cell(row, 'license'),
            });
        }
        if (items.length === 0) throw new FormularyError('檔案裡沒有任何有藥名（或許可證字號）的資料列');
        return {
            items,
            rawRows: dataRows.length,
            excluded,
            hasNhiColumn: columns.nhiCode !== undefined,
            hasLicenseColumn: columns.license !== undefined,
            // 由內容判斷的許可證欄：{ header, ratio }；表頭本來就認得時為 null
            licenseDetected: licenseDetected && { header: cleanCell(licenseDetected.header), ratio: licenseDetected.ratio },
        };
    }

    // 只在表頭沒有許可證欄時呼叫；已對應到其他欄位者不列入候選。取比例最高且過半者
    function detectLicenseColumn(headerCells, dataRows, columns) {
        const taken = new Set(Object.values(columns));
        const width = Math.max(headerCells.length, ...dataRows.map(r => r.length));
        let best = null;
        for (let c = 0; c < width; c += 1) {
            if (taken.has(c)) continue;
            let filled = 0, hits = 0;
            for (const row of dataRows) {
                const v = nfkc(row[c]).replace(/\s+/g, '');
                if (!v) continue;
                filled += 1;
                if (LICENSE_VALUE_RE.test(v)) hits += 1;
            }
            const ratio = filled ? hits / filled : 0;
            if (ratio > LICENSE_DETECT_RATIO && (!best || ratio > best.ratio)) {
                best = { index: c, ratio, header: headerCells[c] };
            }
        }
        return best;
    }

    const isOle = bytes => bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
    const isZip = bytes => bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;

    // 唯一的匯入入口：任何不支援或無法可靠判讀的情況整份拋錯，不回傳部分結果
    async function parseFormularyFile(fileName, buffer) {
        const name = String(fileName || '');
        const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
        if (bytes.length === 0) throw new FormularyError('檔案是空的');
        if (bytes.length > MAX_FILE_BYTES) throw new FormularyError('檔案超過 5 MB 上限');
        // .xls 與加密的 Office 檔都是 OLE 容器
        if (/\.xls$/i.test(name) || isOle(bytes)) {
            throw new FormularyError('不支援 .xls 或加密的 Office 檔，請另存為未加密的 .xlsx 或 .csv');
        }
        let rows;
        if (/\.xlsx$/i.test(name)) {
            if (!isZip(bytes)) throw new FormularyError(BAD_XLSX);
            rows = await readXlsxRows(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        } else if (/\.csv$/i.test(name)) {
            if (isZip(bytes)) throw new FormularyError('檔案內容不是 CSV');
            rows = parseCsv(decodeText(bytes));
        } else {
            throw new FormularyError('僅支援 .csv 與 .xlsx');
        }
        return rowsToFormulary(rows);
    }

    // ── 分類（K1–K4）────────────────────────────────────────────
    // 每個鍵的命中狀態：0 張／1 張／多張。對照表保留一對多，不在建表時只留一張。
    function buildSiteIndexes(drugs) {
        const byNhi = new Map();
        const byLicense = new Map();
        const add = (map, key, lic) => {
            if (!key) return;
            if (!map.has(key)) map.set(key, new Set());
            map.get(key).add(lic);
        };
        for (const d of drugs || []) {
            const lic = d && d.licenseNumber;
            if (!lic) continue;
            add(byLicense, normalizeLicense(lic), lic);
            for (const m of d.nhiMatches || []) add(byNhi, normalizeNhiCode(m && m.code), lic);
        }
        return { byNhi, byLicense };
    }

    function keyState(map, key) {
        const set = key ? map.get(key) : null;
        if (!set || set.size === 0) return { n: 0 };
        if (set.size === 1) return { n: 1, lic: set.values().next().value };
        return { n: 2 };
    }

    // 依序判定，先符合者為準：K3 → K1 → K2 → K4
    function classifyItem(item, site) {
        const nhi = keyState(site.byNhi, item.nhiCode);
        const lic = keyState(site.byLicense, normalizeLicense(item.license));
        if (nhi.n === 2 || lic.n === 2) return { kind: 'K3' };
        if (nhi.n === 1 && lic.n === 1 && nhi.lic !== lic.lic) return { kind: 'K3' };
        if (nhi.n === 1) return { kind: 'K1', license: nhi.lic };
        if (lic.n === 1) return { kind: 'K2', license: lic.lic };
        return { kind: 'K4' };
    }

    // 由「目前站上資料＋目前清單」推導全部對照；不保存（站上資料每週更新）
    function classify(items, drugs) {
        const site = buildSiteIndexes(drugs);
        // N0：無品名且未以代碼對上（K3／K4）的品項，摘要併入「無藥名」，不進未對應區塊與名稱候選
        const counts = { K1: 0, K2: 0, K3: 0, K4: 0, N0: 0 };
        const byLicense = new Map();     // 許可證字號 → { items: [{item, kind}], byNhi: Map(健保代號 → [item]) }
        const classified = [];
        const unmatched = [];            // K3／K4
        const nameIndex = new Map();     // 正規化名稱 → [item]（K3／K4，供名稱候選）

        for (const item of items || []) {
            const result = classifyItem(item, site);
            classified.push({ item, ...result });
            const matched = result.kind === 'K1' || result.kind === 'K2';
            if (!matched && !item.name && !item.enName) { counts.N0 += 1; continue; }
            counts[result.kind] += 1;
            if (matched) {
                if (!byLicense.has(result.license)) byLicense.set(result.license, { items: [], byNhi: new Map() });
                const entry = byLicense.get(result.license);
                entry.items.push({ item, kind: result.kind });
                if (result.kind === 'K1') {
                    if (!entry.byNhi.has(item.nhiCode)) entry.byNhi.set(item.nhiCode, []);
                    entry.byNhi.get(item.nhiCode).push(item);
                }
            } else {
                unmatched.push({ item, kind: result.kind });
                for (const n of new Set([normalizeText(item.name), normalizeText(item.enName)])) {
                    if (!n) continue;
                    if (!nameIndex.has(n)) nameIndex.set(n, []);
                    nameIndex.get(n).push(item);
                }
            }
        }
        return { counts, byLicense, classified, unmatched, nameIndex };
    }

    // 卡片名稱候選：K3／K4 品項的名稱與卡片中文或英文品名正規化後完整相等
    function nameCandidates(match, drug) {
        if (!match || !drug) return [];
        const out = new Set();
        for (const n of [normalizeText(drug.chName), normalizeText(drug.enName)]) {
            if (n && match.nameIndex.has(n)) match.nameIndex.get(n).forEach(i => out.add(i));
        }
        return [...out];
    }

    // 未對應區塊：K3／K4 中，中文名／英文名／成分包含關鍵字者
    function unmatchedHits(match, keyword) {
        const kw = normalizeText(keyword);
        if (!match || [...kw].length < UNMATCHED_MIN_CHARS) return { total: 0, list: [] };
        const hits = match.unmatched.filter(({ item }) =>
            [item.name, item.enName, item.ingredient].some(v => normalizeText(v).includes(kw)));
        return { total: hits.length, list: hits.slice(0, UNMATCHED_LIMIT) };
    }

    // 匯入經過天數（以使用者當地日曆日相減）；無效或未來日期回 null
    function importAgeDays(importedAt, now = new Date()) {
        const t = Number(importedAt);
        if (!Number.isFinite(t) || t <= 0) return null;
        const d = new Date(t);
        if (Number.isNaN(d.getTime())) return null;
        const day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
        const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
        const age = Math.round((today - day) / 86400000);
        return age < 0 ? null : age;
    }

    // 讀回的紀錄須形狀正確，否則視為未匯入（不信任儲存層內容）
    function isValidRecord(rec) {
        if (!rec || typeof rec !== 'object' || !Array.isArray(rec.items) || rec.items.length === 0) return false;
        return rec.items.every(it => it && typeof it === 'object'
            && Object.keys(it).length === STORED_FIELDS.length
            && STORED_FIELDS.every(f => typeof it[f] === 'string'));
    }

    // ── 儲存層（IndexedDB 薄介面）──────────────────────────────
    // 成功＝交易 complete（不是單一 request 的 success）；abort／error 一律回報失敗。
    const DB_NAME = 'tfda-info-search-formulary';   // 前綴只為避免與同 origin 其他專案撞名，不是存取隔離
    const DB_STORE = 'formulary';
    const DB_KEY = 'current';

    function createStore(idb) {
        function open() {
            return new Promise((resolve, reject) => {
                if (!idb) { reject(new FormularyError('此瀏覽器無法使用本機儲存')); return; }
                let req;
                try { req = idb.open(DB_NAME, 1); }
                catch { reject(new FormularyError('無法開啟本機儲存')); return; }
                req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(new FormularyError('無法開啟本機儲存'));
                req.onblocked = () => reject(new FormularyError('本機儲存被其他分頁占用，請關閉其他分頁後重試'));
            });
        }

        async function run(mode, action, failMsg) {
            const db = await open();
            return new Promise((resolve, reject) => {
                let result;
                let tx;
                try {
                    tx = db.transaction(DB_STORE, mode);
                    const req = action(tx.objectStore(DB_STORE));
                    req.onsuccess = () => { result = req.result; };
                } catch {
                    db.close();
                    reject(new FormularyError(failMsg));
                    return;
                }
                tx.oncomplete = () => { db.close(); resolve(result); };
                tx.onabort = () => { db.close(); reject(new FormularyError(failMsg)); };
                tx.onerror = () => {};   // 交易失敗必接著 abort，統一由 onabort 回報
            });
        }

        return {
            load: () => run('readonly', s => s.get(DB_KEY), '讀取院內清單失敗'),
            save: record => run('readwrite', s => s.put(record, DB_KEY), '寫入院內清單失敗（可能是儲存空間不足）'),
            clear: () => run('readwrite', s => s.delete(DB_KEY), '清除院內清單失敗'),
        };
    }

    root.TFDAFormulary = {
        MAX_FILE_BYTES, MAX_ROWS, STALE_DAYS, UNMATCHED_LIMIT, STORED_FIELDS,
        FormularyError,
        normalizeNhiCode, normalizeLicense, normalizeInnerCode, normalizeText,
        parseCsv, decodeText, readXlsxRows, rowsToFormulary, parseFormularyFile,
        classify, nameCandidates, unmatchedHits, importAgeDays, isValidRecord,
        createStore,
    };
})(typeof globalThis !== 'undefined' ? globalThis : self);
