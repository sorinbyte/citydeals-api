import assert from "node:assert/strict";
import { test } from "node:test";

import { composeDealCopy, wholeScopeNoun } from "@/lib/deal-copy";

/*
  The offer sentences every client prints. Worth testing because the failure mode is silent: bad
  Romanian doesn't throw, it just makes the product look like it was written by someone who doesn't
  speak the language.
*/

test("1+1 names the item and states the fixed rule", () => {
  assert.deepEqual(composeDealCopy({ type: "one_plus_one", itemLabel: "felul principal" }), {
    title: "1+1 la felul principal",
    condition: "Produsul cu valoarea mai mică este gratuit.",
  });
});

test("1+1 condition never varies", () => {
  const a = composeDealCopy({ type: "one_plus_one", itemLabel: "tunsoarea" });
  const b = composeDealCopy({ type: "one_plus_one", itemLabel: "bolul de ramen" });
  assert.equal(a.condition, b.condition);
});

test("free item agrees with the article's gender", () => {
  /* The whole reason requiredGender exists — "unui croissant" but "unei cafele". */
  assert.equal(
    composeDealCopy({
      type: "free_item",
      itemLabel: "o cafea",
      requiredItem: "croissant",
      requiredGender: "m",
    }).condition,
    "La achiziția unui croissant.",
  );

  assert.equal(
    composeDealCopy({
      type: "free_item",
      itemLabel: "un desert",
      requiredItem: "cafele",
      requiredGender: "f",
    }).condition,
    "La achiziția unei cafele.",
  );
});

test("free item with nothing required says so", () => {
  assert.equal(
    composeDealCopy({
      type: "free_item",
      itemLabel: "o consultație",
      requiredItem: null,
      requiredGender: null,
    }).condition,
    "Fără altă comandă.",
  );
});

test("free item title uses invariable gratis and sentence-cases the noun", () => {
  /* "gratis" doesn't inflect, so it fits a masculine and a feminine noun alike — which is why the
     free item needs no gender of its own. */
  assert.equal(
    composeDealCopy({
      type: "free_item",
      itemLabel: "cafea",
      requiredItem: null,
      requiredGender: null,
    }).title,
    "Cafea gratis",
  );
  assert.equal(
    composeDealCopy({
      type: "free_item",
      itemLabel: "croissant",
      requiredItem: null,
      requiredGender: null,
    }).title,
    "Croissant gratis",
  );
});

test("free item capitalises only the first letter", () => {
  assert.equal(
    composeDealCopy({
      type: "free_item",
      itemLabel: "supă miso",
      requiredItem: null,
      requiredGender: null,
    }).title,
    "Supă miso gratis",
  );
});

test("percentage over everything names what everything is at this venue", () => {
  assert.deepEqual(
    composeDealCopy({
      type: "percentage",
      percentOff: 20,
      scopeLabel: null,
      wholeScopeNoun: wholeScopeNoun("menu"),
    }),
    {
      title: "−20% la tot meniul",
      condition: "Se aplică la tot meniul, fără alte condiții.",
    },
  );

  assert.equal(
    composeDealCopy({
      type: "percentage",
      percentOff: 15,
      scopeLabel: null,
      wholeScopeNoun: wholeScopeNoun("services"),
    }).title,
    "−15% la toate serviciile",
  );

  /* A cinema or a karting track has no price list at all. */
  assert.equal(
    composeDealCopy({
      type: "percentage",
      percentOff: 10,
      scopeLabel: null,
      wholeScopeNoun: wholeScopeNoun(null),
    }).title,
    "−10% la toată nota",
  );
});

test("percentage scoped to a section says only that section", () => {
  assert.deepEqual(
    composeDealCopy({
      type: "percentage",
      percentOff: 15,
      scopeLabel: "Mic dejun",
      wholeScopeNoun: wholeScopeNoun("menu"),
    }),
    {
      title: "−15% la Mic dejun",
      condition: "Se aplică doar la Mic dejun.",
    },
  );
});

test("percentage uses a real minus sign, not a hyphen", () => {
  const { title } = composeDealCopy({
    type: "percentage",
    percentOff: 20,
    scopeLabel: null,
    wholeScopeNoun: wholeScopeNoun("menu"),
  });

  assert.ok(title.startsWith("−"), "expected U+2212 MINUS SIGN");
  assert.ok(!title.includes("-"), "expected no ASCII hyphen");
});
