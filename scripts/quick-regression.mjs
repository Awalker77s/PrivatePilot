import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

let assertionCount = 0;
function assert(condition, message) {
  assertionCount++;
  if (!condition) throw new Error(message);
}

try {
  const { tryQuickCompile } = await server.ssrLoadModule(
    "/src/pipeline/quickDraft.ts"
  );
  const { DELTA_VERB_RE } = await server.ssrLoadModule("/src/ui/memory.ts");
  const { isCompactReadRequest } = await server.ssrLoadModule(
    "/src/pipeline/compactDraft.ts"
  );
  const compile = (userText) =>
    tryQuickCompile({ userText, answers: [], history: undefined });

  const chain = compile(
    "Every morning at 7 AM, get the top 5 artificial intelligence headlines, identify the two most important stories, then draft a concise email brief with links and one line on why each matters."
  );
  assert(chain?.kind === "draft", "news-email prompt should compile locally");
  assert(chain.draft.automations.length === 2, "news-email prompt should build two jobs");
  assert(chain.draft.chain?.links.length === 1, "news-email prompt should build one hand-off");
  assert(
    chain.draft.chain.links[0].map[0].output === "headlines" &&
      chain.draft.chain.links[0].map[0].input === "headlines",
    "news-email hand-off should carry the verified headlines"
  );

  const richNews = compile(
    "Show me the top 6 technology headlines, highlight the two most important stories, and summarize the three biggest themes."
  );
  assert(richNews?.kind === "draft", "rich news prompt should compile locally");
  assert(
    richNews.draft.automations[0].steps.some((step) => step.includes("Most important")) &&
      richNews.draft.automations[0].steps.some((step) => step.includes("Themes")),
    "rich news prompt should preserve its editorial requirements"
  );

  const stock = compile("Check the Tesla stock price and previous close.");
  assert(stock?.kind === "draft", "stock prompt should compile locally");
  assert(
    stock.draft.automations[0].sources.includes("api.nasdaq.com"),
    "stock prompt should use the no-key Nasdaq source"
  );

  const mixedMarket = compile("Check Bitcoin and Tesla prices");
  assert(
    mixedMarket?.kind === "draft",
    "the market starter should compile locally"
  );
  assert(
    mixedMarket.draft.automations.length === 2,
    "the market starter should build both Bitcoin and Tesla"
  );

  const privateDiscord = compile("Check my unread Discord messages.");
  assert(privateDiscord?.kind === "question", "private Discord should ask instead of guessing");

  const visibleDiscord = compile(
    "Every morning at 9, check the Discord app messages shown on screen."
  );
  assert(
    visibleDiscord?.kind === "draft" &&
      visibleDiscord.draft.automations[0].apps.includes("computer"),
    "a visible Discord app request should compile locally with the computer fence"
  );

  assert(
    isCompactReadRequest({
      userText: "Every morning at 9, open Notepad and tell me the first line shown.",
      answers: [],
    }),
    "a simple custom screen-reading job should use the lightweight compiler"
  );

  assert(
    !DELTA_VERB_RE.test("Every day at 7 PM, check Bitcoin and its 24-hour change."),
    "a new scheduled job must not look like an edit"
  );
  assert(DELTA_VERB_RE.test("Make it 6 AM."), "an explicit schedule edit should look like an edit");

  console.log(`Quick regression suite passed (${assertionCount} assertions).`);
} finally {
  await server.close();
}
