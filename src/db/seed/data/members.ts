/*
  Placeholder members, so the admin members page has something to render before the app ships.

  ⚠️ EVERY number here is on +40700, and that is load-bearing. Romania's 070 range is not allocated
  to mobile operators, so none of these can reach a real handset — and the prefix is what lets the
  seed recognise its own rows. The guard in seed/index.ts refuses to run if it finds a member
  OUTSIDE this range, and the delete only ever touches numbers inside it. A real signup can
  therefore never be counted as seed data or removed by re-seeding.

  Same trick as the leads' `.invalid` email domain, for the same reason: identity data needs a
  provenance marker that can't collide with the real thing.

  Trial dates are relative to when the seed runs, not fixed, so "trial expires within 3 days" always
  has members in it — otherwise that segment tests as empty a week after seeding and looks broken.
*/

export type MemberSeed = {
  /* Local part only; the prefix is added at insert time so it can't drift row by row. */
  phoneSuffix: string;
  name: string | null;
  /* Days from now. Negative is in the past, null means no trial was ever started. */
  trialEndsInDays: number | null;
  /* How long the trial runs in total, used to back-date its start. */
  trialLengthDays: number;
  /* Days ago. Null means verified and never came back — a real and interesting state. */
  lastSeenDaysAgo: number | null;
  joinedDaysAgo: number;
};

export const memberSeed: MemberSeed[] = [
  /* ── In trial, expiring within 3 days — the one segment that has a source ───────────────── */
  {
    phoneSuffix: "000001",
    name: "Maria Popescu",
    trialEndsInDays: 1,
    trialLengthDays: 14,
    lastSeenDaysAgo: 0,
    joinedDaysAgo: 13,
  },
  {
    phoneSuffix: "000002",
    name: "Andrei Ionescu",
    trialEndsInDays: 2,
    trialLengthDays: 14,
    lastSeenDaysAgo: 1,
    joinedDaysAgo: 12,
  },
  {
    /* No name — optional at signup, and support works off the number anyway. */
    phoneSuffix: "000003",
    name: null,
    trialEndsInDays: 3,
    trialLengthDays: 14,
    lastSeenDaysAgo: 4,
    joinedDaysAgo: 11,
  },

  /* ── In trial, plenty of time left ──────────────────────────────────────────────────────── */
  {
    phoneSuffix: "000004",
    name: "Elena Dumitrescu",
    trialEndsInDays: 9,
    trialLengthDays: 14,
    lastSeenDaysAgo: 0,
    joinedDaysAgo: 5,
  },
  {
    phoneSuffix: "000005",
    name: "Cristian Vlad",
    trialEndsInDays: 12,
    trialLengthDays: 14,
    lastSeenDaysAgo: 2,
    joinedDaysAgo: 2,
  },

  /* ── Trial expired ──────────────────────────────────────────────────────────────────────── */
  {
    phoneSuffix: "000006",
    name: "Ioana Marin",
    trialEndsInDays: -2,
    trialLengthDays: 14,
    lastSeenDaysAgo: 3,
    joinedDaysAgo: 16,
  },
  {
    phoneSuffix: "000007",
    name: "Radu Constantin",
    trialEndsInDays: -21,
    trialLengthDays: 14,
    lastSeenDaysAgo: 25,
    joinedDaysAgo: 35,
  },
  {
    phoneSuffix: "000008",
    name: "Alexandra Neagu",
    trialEndsInDays: -60,
    trialLengthDays: 14,
    /* Verified, trialled, and never opened it again. */
    lastSeenDaysAgo: null,
    joinedDaysAgo: 74,
  },

  /* ── Verified, never started a trial ────────────────────────────────────────────────────── */
  {
    phoneSuffix: "000009",
    name: "Bogdan Stan",
    trialEndsInDays: null,
    trialLengthDays: 0,
    lastSeenDaysAgo: 6,
    joinedDaysAgo: 8,
  },
  {
    phoneSuffix: "000010",
    name: null,
    trialEndsInDays: null,
    trialLengthDays: 0,
    /* The worst funnel state there is: verified a phone number and never came back. */
    lastSeenDaysAgo: null,
    joinedDaysAgo: 30,
  },
  {
    phoneSuffix: "000011",
    name: "Ștefania Roșu",
    trialEndsInDays: null,
    trialLengthDays: 0,
    lastSeenDaysAgo: 1,
    joinedDaysAgo: 1,
  },
  {
    phoneSuffix: "000012",
    name: "Gabriel Țiriac",
    trialEndsInDays: -5,
    trialLengthDays: 30,
    lastSeenDaysAgo: 12,
    joinedDaysAgo: 40,
  },
];
