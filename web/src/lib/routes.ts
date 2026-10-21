/**
 * Offshore routes for the globe: the secrecy jurisdictions named in the
 * register's "Intermediate Entities", or a default illustration.
 */
export interface Route {
  label: string;
  lat: number;
  lon: number;
  weight?: number;
}

export const DEFAULT_ROUTES: Route[] = [
  { label: "Mauritius", lat: -20.35, lon: 57.55 },
  { label: "London", lat: 51.51, lon: -0.13 },
  { label: "Jersey", lat: 49.21, lon: -2.13 },
  { label: "Cayman Islands", lat: 19.31, lon: -81.25 },
  { label: "British Virgin Islands", lat: 18.42, lon: -64.64 },
  { label: "Dubai", lat: 25.2, lon: 55.27 },
  { label: "Delaware", lat: 39.16, lon: -75.52 },
  { label: "Singapore", lat: 1.35, lon: 103.82 },
  { label: "Zurich", lat: 47.37, lon: 8.54 },
];


/** Arc set from real register records: jurisdictions named in "Intermediate Entities". */
const CATALOG: (Route & { markers: string[] })[] = [
  { label: "Mauritius", lat: -20.35, lon: 57.55, markers: ["mauritius"] },
  { label: "London", lat: 51.51, lon: -0.13, markers: ["london", "united kingdom"] },
  { label: "Jersey", lat: 49.21, lon: -2.13, markers: ["jersey"] },
  { label: "Cayman Islands", lat: 19.31, lon: -81.25, markers: ["cayman"] },
  { label: "British Virgin Islands", lat: 18.42, lon: -64.64, markers: ["british virgin", "bvi", "tortola"] },
  { label: "Dubai", lat: 25.2, lon: 55.27, markers: ["dubai", "difc", "united arab emirates"] },
  { label: "Delaware", lat: 39.16, lon: -75.52, markers: ["delaware"] },
  { label: "Singapore", lat: 1.35, lon: 103.82, markers: ["singapore"] },
  { label: "Zurich", lat: 47.37, lon: 8.54, markers: ["zurich", "switzerland", "swiss", "geneva"] },
  { label: "Panama", lat: 8.98, lon: -79.52, markers: ["panama"] },
  { label: "Luxembourg", lat: 49.61, lon: 6.13, markers: ["luxembourg"] },
  { label: "Cyprus", lat: 35.17, lon: 33.36, markers: ["cyprus", "nicosia"] },
  { label: "Seychelles", lat: -4.68, lon: 55.49, markers: ["seychelles"] },
];

export function routesFromRecords(records: Record<string, unknown>[]): Route[] | null {
  const counts = new Map<string, number>();
  for (const r of records || []) {
    const text = String(r?.["Intermediate Entities"] ?? "").toLowerCase();
    if (!text) continue;
    for (const entry of CATALOG) {
      if (entry.markers.some((m) => text.includes(m))) counts.set(entry.label, (counts.get(entry.label) || 0) + 1);
    }
  }
  const routes = CATALOG.filter((c) => counts.has(c.label)).map(({ label, lat, lon }) => ({
    label, lat, lon, weight: counts.get(label) || 1,
  }));
  if (!routes.length) return null;
  return routes.sort((a, b) => (b.weight! - a.weight!) || a.label.localeCompare(b.label));
}
