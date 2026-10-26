export type Region = 'south_bay' | 'westside' | 'la_other' | 'other';

// Edit these lists to change how leads are tagged in Slack. Matching is by substring on the
// lowercased city text, longest name first.
const SOUTH_BAY = [
  'redondo beach', 'redondo', 'hermosa beach', 'hermosa', 'manhattan beach', 'torrance', 'el segundo',
  'palos verdes', 'rolling hills', 'lomita', 'gardena', 'hawthorne', 'lawndale', 'carson', 'san pedro',
  'harbor city', 'beach cities', 'south bay',
];
const WESTSIDE = [
  'santa monica', 'venice', 'marina del rey', 'culver city', 'west la', 'west los angeles', 'brentwood',
  'pacific palisades', 'westwood', 'playa vista', 'playa del rey', 'mar vista', 'beverly hills',
  'century city', 'sawtelle', 'west hollywood', 'malibu', 'westside',
];
const LA_OTHER = [
  'los angeles', 'long beach', 'pasadena', 'glendale', 'burbank', 'inglewood', 'compton', 'downey',
  'santa clarita', 'van nuys', 'sherman oaks', 'encino', 'hollywood', 'downtown la', 'dtla', 'orange county',
  'irvine', 'anaheim', 'santa ana', 'huntington beach', 'costa mesa', 'newport beach',
];

const SOUTH_BAY_ZIPS = new Set([
  '90245', '90254', '90266', '90277', '90278', '90501', '90502', '90503', '90504', '90505', '90506',
  '90508', '90509', '90510', '90274', '90275', '90717', '90247', '90248', '90249', '90250', '90260',
  '90745', '90746', '90710', '90731', '90732',
]);
const WESTSIDE_ZIPS = new Set([
  '90401', '90402', '90403', '90404', '90405', '90291', '90292', '90293', '90230', '90232', '90066',
  '90025', '90024', '90049', '90064', '90067', '90077', '90272', '90265', '90210', '90211', '90212',
  '90094', '90069',
]);

const byLength = (a: string, b: string) => b.length - a.length;

function firstMatch(text: string, names: string[]): boolean {
  return [...names].sort(byLength).some((n) => text.includes(n));
}

/** Normalises free-text city (optionally with state or ZIP) to the region used in lead alerts. */
export function normalizeRegion(city: string | undefined): Region {
  const text = (city ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return 'other';

  const zip = /\b(\d{5})\b/.exec(text)?.[1];
  if (zip) {
    if (SOUTH_BAY_ZIPS.has(zip)) return 'south_bay';
    if (WESTSIDE_ZIPS.has(zip)) return 'westside';
  }
  if (firstMatch(text, SOUTH_BAY)) return 'south_bay';
  if (firstMatch(text, WESTSIDE)) return 'westside';
  if (firstMatch(text, LA_OTHER)) return 'la_other';
  if (zip && /^9[0-1]\d{3}$/.test(zip)) return 'la_other';
  return 'other';
}
