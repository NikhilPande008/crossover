// Reference cities used to label heatmap cells. Geography only, no Qloo data.
// Heatmap cells are mapped to the nearest city within MAX_KM.

export type City = { name: string; country: "US" | "GB" | "CA" | "AU" | "IN"; lat: number; lon: number };

export const CITIES: City[] = [
  { name: "New York", country: "US", lat: 40.7128, lon: -74.006 },
  { name: "Los Angeles", country: "US", lat: 34.0522, lon: -118.2437 },
  { name: "Chicago", country: "US", lat: 41.8781, lon: -87.6298 },
  { name: "Houston", country: "US", lat: 29.7604, lon: -95.3698 },
  { name: "Phoenix", country: "US", lat: 33.4484, lon: -112.074 },
  { name: "Philadelphia", country: "US", lat: 39.9526, lon: -75.1652 },
  { name: "San Antonio", country: "US", lat: 29.4241, lon: -98.4936 },
  { name: "San Diego", country: "US", lat: 32.7157, lon: -117.1611 },
  { name: "Dallas", country: "US", lat: 32.7767, lon: -96.797 },
  { name: "Austin", country: "US", lat: 30.2672, lon: -97.7431 },
  { name: "San Francisco", country: "US", lat: 37.7749, lon: -122.4194 },
  { name: "Seattle", country: "US", lat: 47.6062, lon: -122.3321 },
  { name: "Denver", country: "US", lat: 39.7392, lon: -104.9903 },
  { name: "Washington DC", country: "US", lat: 38.9072, lon: -77.0369 },
  { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589 },
  { name: "Nashville", country: "US", lat: 36.1627, lon: -86.7816 },
  { name: "Portland", country: "US", lat: 45.5152, lon: -122.6784 },
  { name: "Atlanta", country: "US", lat: 33.749, lon: -84.388 },
  { name: "Miami", country: "US", lat: 25.7617, lon: -80.1918 },
  { name: "Minneapolis", country: "US", lat: 44.9778, lon: -93.265 },
  { name: "New Orleans", country: "US", lat: 29.9511, lon: -90.0715 },
  { name: "Detroit", country: "US", lat: 42.3314, lon: -83.0458 },
  { name: "Salt Lake City", country: "US", lat: 40.7608, lon: -111.891 },
  { name: "London", country: "GB", lat: 51.5074, lon: -0.1278 },
  { name: "Manchester", country: "GB", lat: 53.4808, lon: -2.2426 },
  { name: "Birmingham", country: "GB", lat: 52.4862, lon: -1.8904 },
  { name: "Glasgow", country: "GB", lat: 55.8642, lon: -4.2518 },
  { name: "Edinburgh", country: "GB", lat: 55.9533, lon: -3.1883 },
  { name: "Bristol", country: "GB", lat: 51.4545, lon: -2.5879 },
  { name: "Leeds", country: "GB", lat: 53.8008, lon: -1.5491 },
  { name: "Liverpool", country: "GB", lat: 53.4084, lon: -2.9916 },
  { name: "Brighton", country: "GB", lat: 50.8225, lon: -0.1372 },
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
