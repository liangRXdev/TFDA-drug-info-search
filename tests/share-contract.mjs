/**
 * 系統分享的資料契約（docs/plan-formulary-share.md 資料流 5）。
 * sw.js 依此讀表單欄位；manifest.json 的 share_target 須與此完全相同（tests/share.spec.mjs E5 擋）。
 */
export const SHARE_TARGET = {
  action: './share',
  method: 'POST',
  enctype: 'application/x-www-form-urlencoded',
  params: { title: 'title', text: 'text', url: 'url' },
};
