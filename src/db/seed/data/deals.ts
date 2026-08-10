/*
  Deals, keyed by venue slug. Split out of venues.ts so both files stay readable.

  `condition` is the catch, in plain Romanian, and it is DISPLAY ONLY. Nothing parses it, matches on
  it, or decides anything from it. Eligibility is worked out server-side from the structured columns
  (type, refreshDays, people) — never from this sentence. If a rule can't be expressed in a column,
  it isn't enforceable, and writing it here doesn't make it so.

  Placeholder content until real partners sign. Savings are in bani, integers, never floats.
*/

export type DealType = "one_plus_one" | "free_item" | "percentage";

export type DealSeed = {
  type: DealType;
  title: string;
  condition: string;
  avgSavingMinor: number;
  refreshDays: number;
  people: 1 | 2;
  percentOff?: number;
};

// 1+1 is two people by definition — the helper enforces it so nobody hand-writes people: 1 here
const bogo = (
  title: string,
  condition: string,
  avgSavingMinor: number,
  refreshDays: number,
): DealSeed => ({ type: "one_plus_one", title, condition, avgSavingMinor, refreshDays, people: 2 });

// people defaults to 1; pass 2 when the condition itself requires a second person or second item
const free = (
  title: string,
  condition: string,
  avgSavingMinor: number,
  refreshDays: number,
  people: 1 | 2 = 1,
): DealSeed => ({ type: "free_item", title, condition, avgSavingMinor, refreshDays, people });

// percentOff is stored, never scraped back out of the title
const pct = (
  percentOff: number,
  title: string,
  condition: string,
  avgSavingMinor: number,
  refreshDays: number,
  people: 1 | 2 = 1,
): DealSeed => ({
  type: "percentage",
  title,
  condition,
  avgSavingMinor,
  refreshDays,
  people,
  percentOff,
});

export const dealsByVenueSlug: Record<string, DealSeed[]> = {
  // ─── Restaurante ──────────────────────────────────────────────────────────────────────────
  "trattoria-bucureseana": [
    bogo(
      "1+1 la felul principal",
      "Comanzi două feluri principale; cel mai ieftin nu se taxează.",
      5500,
      90,
    ),
    free(
      "Desert gratis la comandă",
      "La orice comandă de minimum două feluri principale.",
      2200,
      30,
    ),
    pct(
      20,
      "-20% la băuturi",
      "Se aplică la toate băuturile, inclusiv cocktailurile casei.",
      1500,
      30,
    ),
  ],
  "sushi-master": [
    bogo(
      "1+1 la platourile de sushi",
      "Alegi două platouri; se taxează doar cel mai scump.",
      9500,
      90,
    ),
    free("Supă miso gratuită", "La orice platou comandat.", 1800, 30),
  ],
  "el-torito": [
    bogo("1+1 la tacos", "Două porții de tacos; se taxează una singură.", 3500, 30),
    free("Guacamole din partea casei", "La orice fel principal comandat.", 1900, 30),
  ],
  "taj-palace": [
    pct(
      20,
      "-20% la meniul à la carte",
      "Se aplică la toate felurile din meniul à la carte.",
      4200,
      30,
    ),
    free(
      "Naan gratuit la orice curry",
      "Câte un naan din tandoor la fiecare curry comandat.",
      1200,
      7,
    ),
  ],
  "cafeneaua-veche": [
    bogo(
      "1+1 la cafea de specialitate",
      "Două cafele de specialitate; se taxează una. Valabil la orice oră.",
      1700,
      7,
    ),
    pct(
      15,
      "-15% la mic dejun",
      "Se aplică la meniul de mic dejun, de luni până vineri.",
      2400,
      30,
    ),
  ],
  "osteria-del-corso": [
    pct(25, "-25% la paste", "Se aplică la toate pastele făcute în casă.", 3800, 30),
    free("Tiramisu gratis", "La comanda a două feluri principale.", 2500, 30, 2),
  ],
  "kaido-sushi": [
    bogo("1+1 la ramen", "Două boluri de ramen; se taxează cel mai scump.", 4800, 90),
    pct(10, "-10% la toată nota", "Se aplică pe toată nota, fără condiții suplimentare.", 2600, 30),
  ],
  "taqueria-central": [
    free("3 tacos la preț de 2", "Comanzi trei tacos; se taxează doar două.", 1600, 30),
  ],
  "namaste-bucuresti": [
    pct(
      20,
      "-20% la meniul vegetarian",
      "Se aplică la toate felurile vegetariene și vegane.",
      3300,
      30,
    ),
    free("Lassi gratuit", "Un lassi de mango sau sărat, la orice fel principal.", 1400, 7),
  ],
  "morning-glory": [
    bogo(
      "1+1 la brunch în weekend",
      "Două meniuri de brunch; se taxează unul. Valabil sâmbătă și duminică.",
      6500,
      90,
    ),
  ],
  "pasta-e-basta": [
    pct(15, "-15% la toată nota", "Se aplică pe toată nota, inclusiv băuturile.", 3100, 30),
    free("Focaccia din partea casei", "Servită la începutul mesei, la orice comandă.", 1500, 30),
  ],
  "sakura-bistro": [
    bogo("1+1 la boluri poke", "Două boluri poke; se taxează cel mai scump.", 4400, 90),
    pct(10, "-10% la livrare", "Se aplică la comenzile pentru livrare.", 1200, 7),
  ],
  "casa-mexicana": [
    pct(20, "-20% la fajitas", "Se aplică la toate platourile de fajitas.", 3600, 30),
    free("Nachos din partea casei", "La comanda a două cocktailuri.", 2100, 30, 2),
  ],
  "curry-house": [
    bogo(
      "1+1 la felul principal",
      "Comanzi două feluri principale; se taxează cel mai scump.",
      4600,
      90,
    ),
  ],
  "brunch-and-co": [
    pct(
      15,
      "-15% la mic dejun",
      "Se aplică la meniul de mic dejun, zilnic până la ora 12:00.",
      2300,
      30,
    ),
    free(
      "Cafea gratis la orice croissant",
      "O cafea filtru sau un espresso la fiecare croissant.",
      1300,
      7,
    ),
  ],

  // ─── Sănătate & Frumusețe ─────────────────────────────────────────────────────────────────
  "barber-shop-centrul-vechi": [
    pct(25, "-25% la tuns + barbă", "Se aplică la pachetul de tuns și aranjat barba.", 3000, 30),
    free(
      "A cincea tunsoare gratuită",
      "După patru tunsori înregistrate, a cincea nu se taxează.",
      8000,
      90,
    ),
  ],
  "frizeria-clasica": [
    bogo(
      "1+1 la bărbierit tradițional",
      "Vii însoțit; al doilea bărbierit cu brici nu se taxează.",
      6000,
      90,
    ),
  ],
  "glow-beauty-bar": [
    pct(
      25,
      "-25% la tratamentul facial complet",
      "Se aplică la tratamentul facial complet, cu produse profesionale.",
      9000,
      90,
    ),
    free(
      "Consultație gratuită",
      "Consultație de îngrijire a tenului, fără altă comandă.",
      5000,
      90,
    ),
  ],
  "spa-elysee": [
    pct(20, "-20% la pachetele spa", "Se aplică la toate pachetele spa de o zi.", 12000, 90),
    free("Acces gratuit la saună", "La orice tratament comandat.", 6000, 30),
  ],
  "studio-relax-masaj": [
    bogo(
      "1+1 la masajul de 60 de minute",
      "Două ședințe de 60 de minute; se taxează una.",
      15000,
      90,
    ),
  ],

  // ─── Divertisment ─────────────────────────────────────────────────────────────────────────
  "club-biliard-8-ball": [
    free("O oră gratuită", "La două ore de joc plătite, a treia nu se taxează.", 4000, 30, 2),
    pct(15, "-15% la băuturi", "Se aplică la bar, pe durata jocului.", 1800, 30),
  ],
  "cinema-city": [
    bogo(
      "1+1 la orice bilet de film",
      "Două bilete; se taxează unul. Valabil la orice proiecție 2D.",
      3500,
      30,
    ),
    free("Popcorn mare gratuit", "La achiziția a două bilete.", 2500, 30, 2),
    pct(10, "-10% la snacks", "Se aplică la tot standul de snacks și băuturi.", 1000, 7),
  ],
  "karting-arena": [
    pct(20, "-20% la cursele de seară", "Se aplică la toate cursele de după ora 18:00.", 3000, 30),
    free("A treia cursă gratuită", "La două curse plătite, a treia nu se taxează.", 6000, 90),
  ],
  "padel-club-bucuresti": [
    pct(25, "-25% la închirierea terenului", "Se aplică în orice interval liber.", 5000, 30),
  ],
  "tenis-club-herastrau": [
    bogo(
      "1+1 la orele de dimineață",
      "Două ore de teren; se taxează una. Valabil până la ora 11:00.",
      7000,
      90,
    ),
    free(
      "Închiriere rachetă gratuită",
      "Racheta și mingile sunt incluse la orice rezervare.",
      2000,
      30,
    ),
  ],

  // ─── Retail & Servicii ────────────────────────────────────────────────────────────────────
  "boutique-central": [
    pct(
      10,
      "-10% la toată colecția nouă",
      "Se aplică la toate articolele din colecția curentă.",
      8000,
      90,
    ),
    free("Transport gratuit", "La comenzile online, fără sumă minimă.", 2000, 30),
  ],
  "casa-si-stil": [
    pct(
      15,
      "-15% la decorațiuni",
      "Se aplică la obiectele de decor și textilele din magazin.",
      6000,
      90,
    ),
  ],
  "floraria-iris": [
    pct(
      20,
      "-20% la buchete",
      "Se aplică la buchetele din vitrină și la comenzile personalizate.",
      4000,
      30,
    ),
    free("Livrare gratuită în București", "În oraș, în aceeași zi.", 2500, 30),
  ],
  "service-gsm-expres": [
    pct(
      25,
      "-25% la înlocuirea ecranului",
      "Se aplică la înlocuirea ecranului, cu piese în garanție.",
      15000,
      90,
    ),
    free("Diagnostic gratuit", "Verificare completă a telefonului, fără costuri.", 5000, 30),
  ],
  "croitoria-moderna": [
    pct(15, "-15% la ajustări", "Se aplică la toate ajustările și retușurile.", 3000, 30),
  ],
};
