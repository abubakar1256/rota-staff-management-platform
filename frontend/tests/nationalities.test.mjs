import assert from "node:assert/strict";
import test from "node:test";
import { nationalityOptions, findNationality, searchNationalities } from "../src/nationalities.js";
import { profileDraft, profileFields, profilePercentage, profileStepError } from "../src/profileWizard.js";

test("nationality names are unique and countries with the same nationality share one option", () => {
  const names = nationalityOptions.map((option) => option.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(nationalityOptions.filter((option) => option.name === "British").length, 1);
  assert.equal(nationalityOptions.filter((option) => option.name === "Sudanese").length, 1);
  assert.equal(searchNationalities("French").filter((option) => option.name === "French").length, 1);
  assert.ok(!nationalityOptions.some((option) => option.name === "Pakistan" || option.name === "United Kingdom"));
  assert.notEqual(findNationality("Sudan"), findNationality("South Sudan"));
});

test("search accepts nationalities, country names and previous country codes", () => {
  for (const [query, name] of [["brit", "British"], ["United Kingdom", "British"], ["UK", "British"], ["paki", "Pakistani"], ["Pakistan", "Pakistani"], ["SD", "Sudanese"], ["South Sudan", "South Sudanese"], ["United States", "American"], ["stateless", "Stateless"]]) {
    assert.equal(searchNationalities(query)[0]?.name, name, query);
  }
  assert.equal(searchNationalities("not-a-nationality").length, 0);
  assert.equal(findNationality("paki"), undefined);
  assert.equal(findNationality(" britISH ").name, "British");
});

test("saved country values remain valid and the profile displays the corresponding nationality", () => {
  for (const [oldValue, name] of [["United Kingdom", "British"], ["Pakistan", "Pakistani"], ["Sudan", "Sudanese"], ["South Sudan", "South Sudanese"]]) {
    const details = Object.fromEntries(profileFields.map((field) => [field, field === "nationality" ? oldValue : "Provided"]));
    const draft = profileDraft(details);
    assert.equal(draft.nationality, name);
    assert.equal(profileStepError(draft, 4), null);
    assert.equal(profilePercentage(details, true, true), 100);
  }
});
