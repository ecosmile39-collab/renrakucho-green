import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("./photo-video-consent.html", import.meta.url), "utf8");

test("consent button opens the printable document at the bottom of the media controls", () => {
    const inputPage = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const media = inputPage.slice(inputPage.indexOf('id="mediaSection"'), inputPage.indexOf('id="previewArea"'));
    assert.match(media, /href="photo-video-consent.html" target="_blank" rel="noopener"/);
    assert.ok(media.indexOf('href="photo-video-consent.html"') > media.indexOf('id="cancelPreUploadBtn"'));
});

test("consent document includes all supplied clauses and signature spaces", () => {
    assert.match(page, /<h1>写真・動画の撮影および利用に関する同意書<\/h1>/);
    for (const text of [
        "施設長 殿", "1. 撮影および利用の目的", "ご家族への近況報告（連絡帳）",
        "2. 他の利用者の写り込みおよびプライバシー配慮について",
        "個人のSNSやインターネット上へ無断で公開・投稿しないことを誓約します。",
        "3. 注意事項・同意の撤回について",
        "本同意書の提出有無によって、施設サービスの提供において不利益を受けることはありません。",
        "年　　月　　日", "利用者氏名：", "署名（または代理人）", "家族代表者（続柄：　　　）："
    ]) assert.ok(page.includes(text), `missing consent text: ${text}`);
});

test("document provides printing without including the action controls in print output", () => {
    assert.match(page, /onclick="window.print\(\)"/);
    assert.match(page, /@page\s*\{\s*size: A4 portrait/);
    assert.match(page, /@media print\s*\{[\s\S]*?\.actions\s*\{\s*display: none;/);
    assert.match(page, /この画面では同意情報の登録・保存は行いません/);
});

test("A4 sheet retains internal print margins independently of the browser page margin", () => {
    assert.match(page, /@page\s*\{\s*size: A4 portrait;\s*margin: 0;/);
    assert.match(page, /@media print\s*\{[\s\S]*?main\s*\{[^}]*width: 210mm;[^}]*padding: 18mm;/);
    assert.match(page, /main\s*\{[^}]*min-height: 297mm;/);
});
