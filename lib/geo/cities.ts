// Reference cities used to label heatmap cells. Geography only, no Qloo data.
// pop: approximate metro-area population in millions (rounded public census estimates), used
// only to show market scale next to fan concentration.
// Heatmap cells are mapped to the nearest city within MAX_KM.

export type City = { name: string; country: "US" | "GB" | "CA" | "AU" | "IN"; lat: number; lon: number; pop?: number };

export const CITIES: City[] = [
  { name: "New York", country: "US", lat: 40.7128, lon: -74.006, pop: 19.5 },
  { name: "Los Angeles", country: "US", lat: 34.0522, lon: -118.2437, pop: 12.8 },
  { name: "Chicago", country: "US", lat: 41.8781, lon: -87.6298, pop: 9.3 },
  { name: "Houston", country: "US", lat: 29.7604, lon: -95.3698, pop: 7.3 },
  { name: "Phoenix", country: "US", lat: 33.4484, lon: -112.074, pop: 5.0 },
  { name: "Philadelphia", country: "US", lat: 39.9526, lon: -75.1652, pop: 6.2 },
  { name: "San Antonio", country: "US", lat: 29.4241, lon: -98.4936, pop: 2.6 },
  { name: "San Diego", country: "US", lat: 32.7157, lon: -117.1611, pop: 3.3 },
  { name: "Dallas", country: "US", lat: 32.7767, lon: -96.797, pop: 7.9 },
  { name: "Austin", country: "US", lat: 30.2672, lon: -97.7431, pop: 2.4 },
  { name: "San Francisco", country: "US", lat: 37.7749, lon: -122.4194, pop: 4.6 },
  { name: "Seattle", country: "US", lat: 47.6062, lon: -122.3321, pop: 4.0 },
  { name: "Denver", country: "US", lat: 39.7392, lon: -104.9903, pop: 3.0 },
  { name: "Washington DC", country: "US", lat: 38.9072, lon: -77.0369, pop: 6.3 },
  { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589, pop: 4.9 },
  { name: "Nashville", country: "US", lat: 36.1627, lon: -86.7816, pop: 2.0 },
  { name: "Portland", country: "US", lat: 45.5152, lon: -122.6784, pop: 2.5 },
  { name: "Atlanta", country: "US", lat: 33.749, lon: -84.388, pop: 6.2 },
  { name: "Miami", country: "US", lat: 25.7617, lon: -80.1918, pop: 6.1 },
  { name: "Minneapolis", country: "US", lat: 44.9778, lon: -93.265, pop: 3.7 },
  { name: "New Orleans", country: "US", lat: 29.9511, lon: -90.0715, pop: 1.0 },
  { name: "Detroit", country: "US", lat: 42.3314, lon: -83.0458, pop: 4.3 },
  { name: "Salt Lake City", country: "US", lat: 40.7608, lon: -111.891, pop: 1.3 },
  { name: "London", country: "GB", lat: 51.5074, lon: -0.1278, pop: 9.6 },
  { name: "Manchester", country: "GB", lat: 53.4808, lon: -2.2426, pop: 2.9 },
  { name: "Birmingham", country: "GB", lat: 52.4862, lon: -1.8904, pop: 2.9 },
  { name: "Glasgow", country: "GB", lat: 55.8642, lon: -4.2518, pop: 1.8 },
  { name: "Edinburgh", country: "GB", lat: 55.9533, lon: -3.1883, pop: 0.9 },
  { name: "Bristol", country: "GB", lat: 51.4545, lon: -2.5879, pop: 0.7 },
  { name: "Leeds", country: "GB", lat: 53.8008, lon: -1.5491, pop: 1.9 },
  { name: "Liverpool", country: "GB", lat: 53.4084, lon: -2.9916, pop: 1.4 },
  { name: "Brighton", country: "GB", lat: 50.8225, lon: -0.1372, pop: 0.8 },
];

export const REGIONS: Record<string, { label: string; country: City["country"]; locationQuery: string }> = {
  US: { label: "United States", country: "US", locationQuery: "United States" },
  GB: { label: "United Kingdom", country: "GB", locationQuery: "United Kingdom" },
};

const MAX_KM = 80;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function nearestCity(lat: number, lon: number, country?: string): City | undefined {
  let best: City | undefined;
  let bestKm = Infinity;
  for (const c of CITIES) {
    if (country && c.country !== country) continue;
    const km = haversineKm(lat, lon, c.lat, c.lon);
    if (km < bestKm) {
      best = c;
      bestKm = km;
    }
  }
  return bestKm <= MAX_KM ? best : undefined;
}
