/**
 * 假 IndexedDB（只實作 formulary.js 儲存層用到的部分）。
 *
 * 寫入在交易 complete 時才真正提交，abort 則丟棄——與真實 IndexedDB 相同，
 * 用來驗證「交易 complete 才算成功」（規格 A10）。
 *
 * fail：{ open, get, put, delete }，值為 'error'（request 失敗→交易 abort）或
 *       'abort-after-success'（request 成功後交易才中止）。
 * getDelay：Promise，啟動讀取要等它 resolve 才回應（規格 A9）。
 */
export function makeFakeIdb({ fail = {}, getDelay = null, seed } = {}) {
  const state = {
    data: new Map(),
    calls: { open: 0, get: 0, put: 0, delete: 0 },
    fail: { ...fail },
    getDelay,
  };
  if (seed !== undefined) state.data.set('current', structuredClone(seed));

  const later = fn => setTimeout(fn, 0);

  function transaction() {
    const tx = { oncomplete: null, onabort: null, onerror: null };
    const staged = [];
    let settled = false;
    const finish = ok => later(() => {
      if (settled) return;
      settled = true;
      if (ok) { staged.forEach(fn => fn()); tx.oncomplete && tx.oncomplete(); }
      else { tx.onerror && tx.onerror(); tx.onabort && tx.onabort(); }
    });

    function op(kind, compute, commit) {
      const req = { onsuccess: null, onerror: null, result: undefined };
      state.calls[kind] += 1;
      const run = () => {
        const mode = state.fail[kind];
        if (mode === 'error') { req.onerror && req.onerror(); finish(false); return; }
        req.result = compute();
        if (commit) staged.push(commit);
        req.onsuccess && req.onsuccess();
        finish(mode !== 'abort-after-success');
      };
      if (kind === 'get' && state.getDelay) state.getDelay.then(() => later(run));
      else later(run);
      return req;
    }

    tx.objectStore = () => ({
      get: key => op('get', () => (state.data.has(key) ? structuredClone(state.data.get(key)) : undefined)),
      put: (value, key) => {
        const copy = structuredClone(value);
        return op('put', () => key, () => state.data.set(key, copy));
      },
      delete: key => op('delete', () => undefined, () => state.data.delete(key)),
    });
    return tx;
  }

  const idb = {
    open() {
      state.calls.open += 1;
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null };
      later(() => {
        if (state.fail.open) { req.onerror && req.onerror(); return; }
        req.result = { createObjectStore() {}, close() {}, transaction };
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
  return { idb, state };
}
