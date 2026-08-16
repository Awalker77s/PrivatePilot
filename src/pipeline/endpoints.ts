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
    intent: "US stock price",
    hostnames: ["api.nasdaq.com"],
    urlTemplate:
      "https://api.nasdaq.com/api/quote/{SYMBOL}/info?assetclass=stocks",
    slots: "SYMBOL like AAPL, TSLA, NVDA; fetch /summary too for PreviousClose",
    jsonPath: "data.primaryData.lastSalePrice",
    valueNote: "currency string; daily change beside it; previous close in data.summaryData.PreviousClose.value from /summary",
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
    hostnames: [
      "feeds.bbci.co.uk",
      "www.theguardian.com",
      "rss.nytimes.com",
      "feeds.npr.org",
      "www.aljazeera.com",
    ],
    urlTemplate: "https://feeds.bbci.co.uk/news/world/rss.xml",
    slots:
      "BBC section in the path (/news/technology/, /news/business/, /news/science_and_environment/, /sport/football/) · Guardian: https://www.theguardian.com/{section}/rss (world, business, technology, sport — tag pages work too) · NYT: https://rss.nytimes.com/services/xml/rss/nyt/{World|Business|Technology}.xml · NPR: https://feeds.npr.org/1001/rss.xml (1019 tech, 1006 business) · Al Jazeera: https://www.aljazeera.com/xml/rss/all.xml",
    jsonPath: "(RSS)",
    valueNote: "headlines as text; five publishers, all keyless and feed-shaped",
    cacheTtlSec: 3600,
  },
  {
    intent: "news search on a topic, newest first",
    hostnames: ["hn.algolia.com"],
    urlTemplate:
      "https://hn.algolia.com/api/v1/search_by_date?tags=story&query={topic}&hitsPerPage=5",
    slots: "topic as plain words; drop _by_date for relevance instead of recency",
    jsonPath: "hits[].title",
    valueNote:
      "also hits[].url, .points, .created_at — one GET turns a topic into headlines, which search engines cannot do here",
    cacheTtlSec: 1800,
  },
  {
    intent: "space and launch news",
    hostnames: ["api.spaceflightnewsapi.net"],
    urlTemplate: "https://api.spaceflightnewsapi.net/v4/articles/?limit=5",
    slots: "add &search={term}",
    jsonPath: "results[].title",
    valueNote: "already JSON — .summary, .news_site, .published_at",
    cacheTtlSec: 1800,
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
      "https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t={team}",
    slots: "then eventslast.php?id={idTeam} for the last result, eventsnext.php?id= for the next",
    jsonPath: "teams[0].idTeam",
    valueNote: "scores are strings in results[0].intHomeScore/intAwayScore",
    cacheTtlSec: 300,
  },
  // ---- added after a live sweep of 54 candidates (2026-08-16): every one
  // below answered a plain GET through this app's own fetch path, keyless.
  // Automations were failing on requests these cover — the model had no
  // endpoint to reach for and guessed at a site that blocks programs.
  {
    intent: "severe weather alerts / warnings for a US state",
    hostnames: ["api.weather.gov"],
    urlTemplate: "https://api.weather.gov/alerts/active?area={STATE}",
    slots: "STATE is a two-letter code like FL, CA, TX",
    jsonPath: "features[].properties.headline",
    valueNote: "also .event, .severity, .areaDesc; empty features = nothing active",
    cacheTtlSec: 300,
  },
  {
    intent: "recent earthquakes",
    hostnames: ["earthquake.usgs.gov"],
    urlTemplate:
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
    slots: "swap 2.5_day for 4.5_week or all_hour; magnitude threshold in the name",
    jsonPath: "features[].properties.mag / .place / .time",
    valueNote: "sorted newest first",
    cacheTtlSec: 600,
  },
  {
    intent: "air quality now",
    hostnames: ["air-quality-api.open-meteo.com"],
    urlTemplate:
      "https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}&current=us_aqi,pm2_5",
    slots: "lat/lon from the geocoding step",
    jsonPath: "current.us_aqi",
    valueNote: "number; pm2_5 beside it",
    cacheTtlSec: 900,
  },
  {
    intent: "sunrise / sunset times",
    hostnames: ["api.sunrise-sunset.org"],
    urlTemplate:
      "https://api.sunrise-sunset.org/json?lat={lat}&lng={lon}&formatted=0",
    slots: "lat/lon from the geocoding step; add &date=YYYY-MM-DD for another day",
    jsonPath: "results.sunrise",
    valueNote: "ISO times in UTC",
    cacheTtlSec: 3600,
  },
  {
    intent: "what is X — an encyclopedia summary",
    hostnames: ["en.wikipedia.org"],
    urlTemplate: "https://en.wikipedia.org/api/rest_v1/page/summary/{Title}",
    slots: "Title is the page title with underscores, e.g. Kyoto, Photosynthesis",
    jsonPath: "extract",
    valueNote:
      "plain-text summary; search titles first with /w/api.php?action=query&list=search&srsearch={q}&format=json",
    cacheTtlSec: 86400,
  },
  {
    intent: "word definition",
    hostnames: ["api.dictionaryapi.dev"],
    urlTemplate: "https://api.dictionaryapi.dev/api/v2/entries/en/{word}",
    slots: "one word",
    jsonPath: "[0].meanings[].definitions[0].definition",
    valueNote: "also partOfSpeech and phonetic",
    cacheTtlSec: 86400,
  },
  {
    intent: "country facts (capital, population, currency)",
    hostnames: ["restcountries.com"],
    urlTemplate:
      "https://restcountries.com/v3.1/name/{country}?fields=name,capital,population,currencies,region",
    slots: "country name in plain words",
    jsonPath: "[0].capital[0]",
    valueNote: "population is a number",
    cacheTtlSec: 86400,
  },
  {
    intent: "public holidays for a year",
    hostnames: ["date.nager.at"],
    urlTemplate: "https://date.nager.at/api/v3/PublicHolidays/{year}/{CC}",
    slots: "year like 2026; CC is a country code like US, GB, DE",
    jsonPath: "[].date / [].localName",
    valueNote: "whole year, sorted",
    cacheTtlSec: 86400,
  },
  {
    intent: "medicine / drug label facts",
    hostnames: ["api.fda.gov"],
    urlTemplate: "https://api.fda.gov/drug/label.json?search={drug}&limit=1",
    slots: "drug name like ibuprofen",
    jsonPath: "results[0].warnings / .indications_and_usage",
    valueNote: "long text fields — summarize, never dose advice",
    cacheTtlSec: 86400,
  },
  {
    intent: "book details",
    hostnames: ["openlibrary.org"],
    urlTemplate:
      "https://openlibrary.org/search.json?q={query}&limit=3&fields=title,author_name,first_publish_year",
    slots: "title or author",
    jsonPath: "docs[].title",
    valueNote: "author_name is an array",
    cacheTtlSec: 86400,
  },
  {
    intent: "recipe by dish or ingredient",
    hostnames: ["www.themealdb.com"],
    urlTemplate: "https://www.themealdb.com/api/json/v1/1/search.php?s={dish}",
    slots: "dish name; filter.php?i={ingredient} searches by ingredient",
    jsonPath: "meals[0].strInstructions",
    valueNote: "ingredients are strIngredient1..20 with strMeasure1..20",
    cacheTtlSec: 86400,
  },
  {
    intent: "code repository / package facts",
    hostnames: ["api.github.com", "registry.npmjs.org", "pypi.org", "crates.io"],
    urlTemplate: "https://api.github.com/repos/{owner}/{repo}",
    slots:
      "npm: https://registry.npmjs.org/{pkg}/latest · PyPI: https://pypi.org/pypi/{pkg}/json · crates: https://crates.io/api/v1/crates/{name}",
    jsonPath: "stargazers_count / version / info.version",
    valueNote: "GitHub allows ~60 unauthenticated calls an hour",
    cacheTtlSec: 3600,
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
