import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BIRTHDAY_CARD_DESIGNS, ageOn, birthdayWindow, cardDesignFor, chosenCardDesign, isBirthdayOn, isValidCardDesign } from "./birthday-card.js";

test("every card design matches a print screen choice", () => {
    const print = readFileSync(new URL("./print.html", import.meta.url), "utf8");
    assert.equal(BIRTHDAY_CARD_DESIGNS.length, 11);
    assert.deepEqual(BIRTHDAY_CARD_DESIGNS.filter(design => design.photoCount === 3).map(design => design.value), ["vertical4", "vertical5", "vertical6"]);
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

test("the design can be chosen from 3 days before to 3 days after the birthday", () => {
    assert.deepEqual(birthdayWindow("1937-10-29", "2026-10-29"), { offset: 0, birthdayDate: "2026-10-29", age: 89 });
    assert.deepEqual(birthdayWindow("1937-10-29", "2026-10-26"), { offset: -3, birthdayDate: "2026-10-29", age: 89 });
    assert.deepEqual(birthdayWindow("1937-10-29", "2026-11-01"), { offset: 3, birthdayDate: "2026-10-29", age: 89 });
    assert.equal(birthdayWindow("1937-10-29", "2026-10-25"), null);
    assert.equal(birthdayWindow("1937-10-29", "2026-11-02"), null);
    assert.deepEqual(birthdayWindow("1940-12-30", "2027-01-02"), { offset: 3, birthdayDate: "2026-12-30", age: 86 });
    assert.deepEqual(birthdayWindow("1941-01-02", "2026-12-30"), { offset: -3, birthdayDate: "2027-01-02", age: 86 });
    assert.equal(birthdayWindow("1940-02-29", "2027-03-03").offset, 3);
    assert.equal(birthdayWindow("", "2026-10-29"), null);
});

test("the print screen offers the card from 3 days before to 3 days after the birthday", () => {
    const print = readFileSync(new URL("./print.html", import.meta.url), "utf8");
    assert.match(print, /diffDays >= -3 && diffDays <= 3/);
});

test("a record saved with the retired design 8 is shown as design 7", () => {
    assert.equal(isValidCardDesign("vertical8"), true);
    assert.equal(cardDesignFor("vertical8").value, "vertical7");
    assert.equal(chosenCardDesign([{ date: "2026-10-29", birthdayCardDesign: "vertical8" }]), "vertical7");
});
