// The endpoint catalog — hand-verified, keyless public data sources
// (research pass, live-checked 2026-08-14). The compiler picks from these;
// the runner extracts the exact value; the fence auto-trusts these hosts.
// Verified broken and EXCLUDED: Binance (US 451), Stooq (JS proof-of-work),
// Reddit JSON (403), ESPN (403).

export interface Endpoint {
  intent: string;
  hostnames: string[];
  urlTemplate: string;
  slots: string; // plain-words note about the {slot}
  jsonPath: string; // where the value lives — used for the VALUE: line
  valueNote: string;
  cacheTtlSec: number;
}

export const ENDPOINTS: Endpoint[] = [
  {
    intent: "crypto price",
    hostnames: ["api.coingecko.com"],
    urlTemplate:
      "https://api.coingecko.com/api/v3/simple/price?ids={coinId}&vs_currencies=usd&include_24hr_change=true",
    slots: "coinId is a lowercase slug: bitcoin, ethereum, solana, dogecoin, cardano, ripple",
    jsonPath: "{coinId}.usd",
    valueNote: "number; 24h change at {coinId}.usd_24h_change",
    cacheTtlSec: 60,
  },
  {
    intent: "crypto price (fallback)",
    hostnames: ["api.coinbase.com"],
    urlTemplate: "https://api.coinbase.com/v2/prices/{TICKER}-USD/spot",
    slots: "TICKER like BTC, ETH, SOL",
    jsonPath: "data.amount",
    valueNote: "string number — parse it",
    cacheTtlSec: 60,
  },
  {
    intent: "stock / index / fx-pair price",
    hostnames: ["query1.finance.yahoo.com", "query2.finance.yahoo.com"],
    urlTemplate:
      "https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval=1d&range=1d",
    slots: "SYMBOL like AAPL, TSLA, ^GSPC, EURUSD=X",
    jsonPath: "chart.result[0].meta.regularMarketPrice",
    valueNote: "number; previousClose beside it; check chart.error is null",
    cacheTtlSec: 120,
  },
  {
    intent: "find a city's coordinates (before weather)",
    hostnames: ["geocoding-api.open-meteo.com"],
    urlTemplate:
      "https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1&language=en&format=json",
    slots: "city name in plain words",
    jsonPath: "results[0].latitude, results[0].longitude",
    valueNote: "numbers; also results[0].name and country",
    cacheTtlSec: 86400,
  },
  {
    intent: "weather now / forecast",
    hostnames: ["api.open-meteo.com"],
    urlTemplate:
      "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3",
    slots: "lat/lon from the geocoding step; add &temperature_unit=fahrenheit for °F",
    jsonPath: "current.temperature_2m",
    valueNote: "number; weather_code is a WMO code (see table)",
    cacheTtlSec: 900,
  },
  {
    intent: "currency exchange rate",
    hostnames: ["api.frankfurter.dev"],
    urlTemplate: "https://api.frankfurter.dev/v1/latest?from={FROM}&to={TO}",
    slots: "FROM/TO are codes like USD, EUR, GBP, JPY — must be the .dev/v1 URL",
    jsonPath: "rates.{TO}",
    valueNote: "number",
    cacheTtlSec: 3600,
  },
  {
    intent: "tech news front page",
    hostnames: ["hn.algolia.com"],
    urlTemplate: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10",
    slots: "add &query={topic}&tags=story to search a topic",
    jsonPath: "hits[].title",
    valueNote: "also hits[].url and hits[].points",
    cacheTtlSec: 3600,
  },
  {
    intent: "news headlines about anything",
    hostnames: ["news.google.com"],
    urlTemplate:
      "https://news.google.com/rss/search?q={topic}&hl=en-US&gl=US&ceid=US:en",
    slots: "topic in plain words; plain https://news.google.com/rss for top stories",
    jsonPath: "(RSS — the runner turns items into title/link/date lines)",
    valueNote: "headlines as text",
    cacheTtlSec: 3600,
  },
  {
    intent: "world news",
    hostnames: ["feeds.bbci.co.uk"],
    urlTemplate: "https://feeds.bbci.co.uk/news/world/rss.xml",
    slots: "also /news/technology/rss.xml, /news/business/rss.xml",
    jsonPath: "(RSS)",
    valueNote: "headlines as text",
    cacheTtlSec: 3600,
  },
  {
    intent: "is a service down",
    hostnames: [
      "www.githubstatus.com",
      "discordstatus.com",
      "www.cloudflarestatus.com",
      "status.openai.com",
      "status.anthropic.com",
    ],
    urlTemplate: "https://www.githubstatus.com/api/v2/status.json",
    slots: "same /api/v2/status.json path on each status host",
    jsonPath: "status.description",
    valueNote: 'text like "All Systems Operational"',
    cacheTtlSec: 300,
  },
  {
    intent: "sports team latest result / next game",
    hostnames: ["www.thesportsdb.com"],
    urlTemplate:
      "https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t={team}",
    slots: "then eventslast.php?id={idTeam} for the last result, eventsnext.php?id= for the next",
    jsonPath: "teams[0].idTeam",
    valueNote: "scores are strings in results[0].intHomeScore/intAwayScore",
    cacheTtlSec: 300,
  },
];

// Common-word → CoinGecko slug aliases the compiler can lean on.
export const COIN_ALIASES: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  doge: "dogecoin",
  ada: "cardano",
  xrp: "ripple",
};

// WMO weather codes → plain words (Open-Meteo current.weather_code).
export const WMO_CODES: Record<number, string> = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  51: "light drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  80: "rain showers",
  95: "thunderstorm",
};

export function knownHostnames(): string[] {
  return [...new Set(ENDPOINTS.flatMap((e) => e.hostnames))];
}

// The compact menu injected into the drafting prompt — one line per intent.
export function endpointMenu(): string {
  return ENDPOINTS.map(
    (e) =>
      `- ${e.intent}: ${e.urlTemplate} (${e.slots}; value at ${e.jsonPath})`
  ).join("\n");
}
