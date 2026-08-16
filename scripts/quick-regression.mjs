import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const { tryQuickCompile } = await server.ssrLoadModule(
    "/src/pipeline/quickDraft.ts"
  );
  const { DELTA_VERB_RE } = await server.ssrLoadModule("/src/ui/memory.ts");
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

  const privateDiscord = compile("Check my unread Discord messages.");
  assert(privateDiscord?.kind === "question", "private Discord should ask instead of guessing");

  assert(
    !DELTA_VERB_RE.test("Every day at 7 PM, check Bitcoin and its 24-hour change."),
    "a new scheduled job must not look like an edit"
  );
  assert(DELTA_VERB_RE.test("Make it 6 AM."), "an explicit schedule edit should look like an edit");

  console.log("Quick regression suite passed (13 assertions)." );
} finally {
  await server.close();
}
