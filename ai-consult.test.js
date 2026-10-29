import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AI_SERVICES, buildAiPrompt, removePersonalNames } from "./ai-consult.js";

test("the prompt is built from the chosen conditions", () => {
    const prompt = buildAiPrompt({ topic: "recreation", service: "デイサービス", month: 11, people: "15人くらい", minutes: "30分", conditions: ["車いすの方が多い", "認知症の方も楽しめる"] });
    assert.match(prompt, /デイサービスで11月（秋）に行う30分のレクリエーションを5つ提案してください/);
    assert.match(prompt, /参加者は15人くらいで、車いすの方が多い、認知症の方も楽しめる/);
    assert.match(prompt, /準備物と進め方/);
});

test("each topic makes a different request", () => {
    assert.match(buildAiPrompt({ topic: "seasonal", month: 12 }), /季節の行事.*12月（冬）|12月（冬）.*季節の行事/);
    assert.match(buildAiPrompt({ topic: "birthday", month: 4 }), /誕生日会/);
    assert.match(buildAiPrompt({ topic: "conversation", month: 7 }), /声かけの例を10個/);
});

test("resident names are removed from the free note", () => {
    assert.equal(removePersonalNames("中村 敏子さんが好きな歌", ["中村 敏子"]), "（お名前）さんが好きな歌");
    assert.equal(removePersonalNames("中村さんと佐藤健一さん", ["中村 敏子", "佐藤 健一"]), "（お名前）さんと（お名前）さん");
    const prompt = buildAiPrompt({ note: "中村 敏子さんは歌が好き", userNames: ["中村 敏子"] });
    assert.equal(prompt.includes("中村"), false);
});

test("free AI services open with the question", () => {
    assert.match(AI_SERVICES.chatgpt.url("秋 レク"), /^https:\/\/chatgpt\.com\/\?q=/);
    assert.match(AI_SERVICES.claude.url("秋 レク"), /^https:\/\/claude\.ai\/new\?q=/);
    assert.equal(AI_SERVICES.gemini.pasteOnly, true);
    const index = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    assert.match(index, /id="aiConsultPanel" class="ai-consult-panel" hidden/);
});
