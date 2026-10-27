import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SENTENCE_TEMPLATES, appendTemplateText, templatesFor } from "./sentence-templates.js";
import { GROUP_HOME_FIELDS } from "./group-home.js";
import { RESIDENTIAL_FIELDS } from "./residential-care.js";

const source = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const htmlIds = new Set([...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const datalistIds = new Set([...source.matchAll(/<datalist id="([^"]+)"/g)].map(match => match[1]));
const structuredFields = [...GROUP_HOME_FIELDS, ...RESIDENTIAL_FIELDS];

test("every sentence template points at a real text box", () => {
    const structuredIds = new Set(structuredFields.filter(field => field.type === "textarea").map(field => field.id));
    for (const fieldId of Object.keys(SENTENCE_TEMPLATES)) {
        const inHtml = new RegExp(`<textarea id="${fieldId}"`).test(source);
        assert.ok(inHtml || structuredIds.has(fieldId), `${fieldId} must be a textarea`);
    }
});

test("every service except day service and short stay gets sentence templates for its free-text boxes", () => {
    const covered = new Set(Object.keys(SENTENCE_TEMPLATES));
    for (const id of ["afterSchoolSupport", "afterSchoolEpisode", "lifeCareHealthNote", "lifeCareGoalProgress",
        "lifeCareActivityDetails", "lifeCareEpisode", "lifeCareHandover"]) {
        assert.ok(covered.has(id), id);
    }
    for (const field of structuredFields.filter(field => field.type === "textarea")) {
        assert.ok(covered.has(field.id), field.id);
    }
});

test("child templates switch between after-school day service and early childhood support", () => {
    const afterSchool = templatesFor("afterSchoolSupport", "放課後等デイサービス");
    const earlyChildhood = templatesFor("afterSchoolSupport", "児童発達支援");
    assert.ok(afterSchool.some(text => text.includes("宿題")));
    assert.ok(!earlyChildhood.some(text => text.includes("宿題")));
    assert.ok(earlyChildhood.some(text => text.includes("着替え")));
    assert.ok(afterSchool.includes("公園で体を動かして遊びました。"));
    assert.ok(earlyChildhood.includes("公園で体を動かして遊びました。"));
});

test("a chosen sentence is added after what the staff already wrote", () => {
    assert.equal(appendTemplateText("", "笑顔で過ごしました。"), "笑顔で過ごしました。");
    assert.equal(appendTemplateText("午前は散歩。", "笑顔で過ごしました。"), "午前は散歩。\n笑顔で過ごしました。");
    assert.equal(appendTemplateText("そのまま", ""), "そのまま");
});

test("every suggestion list used by an input exists on the page", () => {
    const usedInHtml = [...source.matchAll(/\blist="([^"]+)"/g)].map(match => match[1]);
    const usedByFields = structuredFields.filter(field => field.list).map(field => field.list);
    for (const listId of [...usedInHtml, ...usedByFields]) {
        assert.ok(datalistIds.has(listId), `missing datalist ${listId}`);
    }
});

test("numbers for vitals are suggested in every service that records them", () => {
    const vitalIds = ["lifeCareTemperature", "lifeCarePulse", "lifeCareBpHigh", "lifeCareBpLow", "lifeCareSpo2", "afterSchoolTemperature"];
    for (const id of vitalIds) {
        assert.ok(htmlIds.has(id));
        assert.match(source, new RegExp(`id="${id}" list="[^"]+"`), id);
    }
    for (const field of structuredFields.filter(field => /(Temp|Pulse|Spo2|BpHigh|BpLow|Water)$/.test(field.id))) {
        assert.ok(field.list, `${field.id} needs suggested values`);
    }
});
