import assert from "node:assert/strict";
import { test } from "node:test";
import { appendText, buildVoiceSummaryPrompt, hasVoiceSummary, parseVoiceSummary } from "./voice-note.js";

test("the prompt keeps what was said but never the user's name", () => {
    const prompt = buildVoiceSummaryPrompt({
        transcript: "山田花子さんは午前の体操に参加。山田さん昼食は全量、37.2℃で少し咳",
        service: "デイサービス",
        userNames: ["山田 花子"]
    });
    assert.ok(!prompt.includes("山田"));
    assert.ok(!prompt.includes("花子"));
    assert.ok(prompt.includes("ご本人は午前の体操に参加"));
    assert.ok(!prompt.includes("ご本人さん"));
    assert.ok(prompt.includes("37.2℃で少し咳"));
    assert.ok(prompt.startsWith("デイサービスのスタッフ"));
    ["【介護日誌】", "【ご家族への連絡事項】", "【申し送り】", "【チェック】"].forEach(head => assert.ok(prompt.includes(head)));
});

test("an AI answer is split into the journal, family message, handover and flags", () => {
    const answer = [
        "**【介護日誌】**",
        "- 午前：体操に参加。",
        "- 昼食：全量摂取。",
        "- 14時：体温37.2℃、軽い咳あり。",
        "",
        "【ご家族への連絡事項】",
        "午前は体操に参加され、昼食もすべて召し上がりました。午後に少し咳が出ていましたので、ご自宅でも様子を見ていただけますと幸いです。",
        "",
        "【申し送り】咳の様子を次回も確認する。",
        "【チェック】要申し送り、体調変化"
    ].join("\n");
    const result = parseVoiceSummary(answer);
    assert.equal(result.careJournal, "午前：体操に参加。\n昼食：全量摂取。\n14時：体温37.2℃、軽い咳あり。");
    assert.ok(result.message.startsWith("午前は体操に参加され"));
    assert.equal(result.handoverNote, "咳の様子を次回も確認する。");
    assert.deepEqual(result.flags, { handoverRequired: true, medicalVisit: false, conditionChange: true });
    assert.equal(hasVoiceSummary(result), true);
});

test("'なし' leaves the handover empty and no flags checked", () => {
    const result = parseVoiceSummary("【介護日誌】\n穏やかに過ごされた。\n【ご家族への連絡事項】\n穏やかに過ごされました。\n【申し送り】\nなし\n【チェック】\nなし");
    assert.equal(result.handoverNote, "");
    assert.deepEqual(result.flags, { handoverRequired: false, medicalVisit: false, conditionChange: false });
    assert.equal(hasVoiceSummary(parseVoiceSummary("こんにちは")), false);
});

test("filling adds to what is already written instead of replacing it", () => {
    assert.equal(appendText("", "新しい内容"), "新しい内容");
    assert.equal(appendText("前の内容", "新しい内容"), "前の内容\n新しい内容");
    assert.equal(appendText("前の内容\n新しい内容", "新しい内容"), "前の内容\n新しい内容");
    assert.equal(appendText("前の内容", ""), "前の内容");
});
