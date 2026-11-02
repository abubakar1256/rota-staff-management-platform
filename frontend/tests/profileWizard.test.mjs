import assert from "node:assert/strict";
import test from "node:test";
import { countryOptions, findCountry, searchCountries } from "../src/countries.js";
import { profileDraft, profileFields, profilePercentage } from "../src/profileWizard.js";

test("country dropdown covers all 249 unique ISO country and territory codes", () => {
  assert.equal(countryOptions.length, 249);
  assert.equal(new Set(countryOptions.map((country) => country.code)).size, 249);
  assert.equal(searchCountries("paki")[0].name, "Pakistan");
  assert.equal(searchCountries("uk")[0].code, "GB");
  assert.equal(findCountry("UNITED KINGDOM").code, "GB");
  assert.equal(searchCountries("not-a-country").length, 0);
});

test("new profiles have no preselected nationality and retain saved drafts", () => {
  assert.equal(profileDraft().nationality, "");
  assert.equal(profileDraft({ nationality: "Pakistan", phone: "123" }).nationality, "Pakistan");
  assert.equal(profileDraft({ phone: "123" }).phone, "123");
});

test("100% requires every guard field, picture and declaration without office-managed joining date", () => {
  const details = Object.fromEntries(profileFields.map((field) => [field, field === "nationality" ? "Pakistan" : "Provided"]));
  assert.equal(profilePercentage(details, false, false), 82);
  assert.equal(profilePercentage(details, true, false), 91);
  assert.equal(profilePercentage(details, true, true), 100);
  assert.ok(profilePercentage({ ...details, nationality: "pak" }, true, true) < 100);
  assert.equal(profilePercentage(profileDraft(), false, false), 0);
});
