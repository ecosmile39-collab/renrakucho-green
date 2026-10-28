import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TEMPERATURE_FIELD_IDS, isFever, markFever, temperatureHtml } from "./fever.js";
import { GROUP_HOME_FIELDS, renderGroupHomeRecord } from "./group-home.js";
import { RESIDENTIAL_FIELDS, renderResidentialRecord } from "./residential-care.js";

test("37.0 and above count as fever, entered or chosen", () => {
    assert.equal(isFever("37.0"), true);
    assert.equal(isFever("37"), true);
    assert.equal(isFever(" 38.5 "), true);
    assert.equal(isFever("36.9"), false);
    assert.equal(isFever(""), false);
    assert.equal(isFever(undefined), false);
    assert.equal(isFever("37度"), false);
});

test("a star is put in front of a fever temperature", () => {
    assert.equal(markFever("37.2"), "★37.2");
    assert.equal(markFever("36.5"), "36.5");
    assert.match(temperatureHtml("37.2"), /★37\.2℃/);
    assert.match(temperatureHtml("37.2"), /color:#c92a2a/);
    assert.equal(temperatureHtml("36.5"), "36.5℃");
    assert.equal(temperatureHtml(""), "--");
    assert.equal(temperatureHtml("", { empty: "未入力" }), "未入力");
    assert.equal(temperatureHtml("<b>"), "&lt;b&gt;℃");
});

test("every temperature box on the input screen is watched", () => {
    const source = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const structured = [...GROUP_HOME_FIELDS, ...RESIDENTIAL_FIELDS].map(field => field.id);
    for (const id of TEMPERATURE_FIELD_IDS) {
        assert.ok(source.includes(`id="${id}"`) || structured.includes(id), id);
    }
    for (const id of ["temp1", "temp2", "stTempIn", "stTempOut", "afterSchoolTemperature", "lifeCareTemperature"]) {
        assert.ok(TEMPERATURE_FIELD_IDS.includes(id), id);
    }
    for (const field of [...GROUP_HOME_FIELDS, ...RESIDENTIAL_FIELDS].filter(field => /Temp$/.test(field.id))) {
        assert.ok(TEMPERATURE_FIELD_IDS.includes(field.id), field.id);
    }
});

test("group home and residential printouts star fever temperatures", () => {
    const home = renderGroupHomeRecord({ ghMorningTemp: "37.1", ghEveningTemp: "36.4" });
    assert.match(home, /★37\.1/);
    assert.doesNotMatch(home, /★36\.4/);
    const residential = renderResidentialRecord({ rsEveningTemp: "38.0" });
    assert.match(residential, /★38\.0/);
});

test("print and past-data screens use the fever display for every service", () => {
    for (const file of ["print.html", "history.html"]) {
        const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
        assert.match(source, /import \{ temperatureHtml \} from "\.\/fever\.js"/, file);
        assert.doesNotMatch(source, /\$\{t\}℃|\$\{tM\}℃|lifeCareTemperature \|\| '未入力'\}℃/, file);
    }
});
