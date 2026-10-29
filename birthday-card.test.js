import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BIRTHDAY_CARD_DESIGNS, ageOn, cardDesignFor, chosenCardDesign, isBirthdayOn, isValidCardDesign } from "./birthday-card.js";

test("the seven card designs match the print screen choices", () => {
    const print = readFileSync(new URL("./print.html", import.meta.url), "utf8");
    assert.equal(BIRTHDAY_CARD_DESIGNS.length, 7);
    for (const design of BIRTHDAY_CARD_DESIGNS) {
        assert.match(print, new RegExp(`<option value="${design.value}"`), design.value);
        assert.match(print, new RegExp(`layout-${design.value}`), design.value);
    }
});

test("a birthday is recognized on the same month and day", () => {
    assert.equal(isBirthdayOn("1937-10-29", "2026-10-29"), true);
    assert.equal(isBirthdayOn("1937-10-22", "2026-10-29"), false);
    assert.equal(isBirthdayOn("", "2026-10-29"), false);
    assert.equal(isBirthdayOn("1940-02-29", "2027-02-28"), true);
    assert.equal(isBirthdayOn("1940-02-29", "2028-02-28"), false);
    assert.equal(isBirthdayOn("1940-02-29", "2028-02-29"), true);
});

test("age is counted on the record date", () => {
    assert.equal(ageOn("1937-10-29", "2026-10-29"), 89);
    assert.equal(ageOn("1937-10-30", "2026-10-29"), 88);
    assert.equal(ageOn("1940-02-29", "2027-02-28"), 87);
});

test("the design chosen on the newest record wins and unknown values are ignored", () => {
    assert.equal(chosenCardDesign([
        { date: "2026-10-28", birthdayCardDesign: "vertical2" },
        { date: "2026-10-29", birthdayCardDesign: "horizontal3" },
        { date: "2026-10-30", birthdayCardDesign: "bogus" },
        { date: "2026-10-31" }
    ]), "horizontal3");
    assert.equal(chosenCardDesign([]), "");
    assert.equal(isValidCardDesign("bogus"), false);
    assert.equal(cardDesignFor("bogus").value, "vertical1");
});

test("the input screen saves the chosen design with the record", () => {
    const index = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    assert.match(index, /id="birthdayCardPicker" hidden/);
    assert.match(index, /birthdayCardDesign: document\.getElementById\("birthdayCardDesign"\)\.value/);
});
