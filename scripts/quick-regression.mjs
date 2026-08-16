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

  // ---- sequences by talking ----
  const { CHAIN_TALK_RE, PLURAL_REF_RE, SEQUENCE_NAME_RE, mentionIndex } =
    await server.ssrLoadModule("/src/ui/memory.ts");
  const { CHAIN_REQUEST_RE } = await server.ssrLoadModule("/src/pipeline/catalog.ts");

  for (const said of [
    "connect Bitcoin Price Check and Bitcoin Email Summary",
    "i want to connect these automations",
    "put these two automations together",
    "make an automation for the price and one for the note, as a chain",
    "chain them together",
    "run them one after the other",
    // said out loud, the ask lands at the end
    "make an automation for this and make an automation for this a chain",
    "make one for the price and one for the note a chain or a sequence",
  ]) {
    assert(CHAIN_TALK_RE.test(said), `chain talk should recognize: ${said}`);
  }
  assert(
    CHAIN_TALK_RE.test("put Tesla Stock Check and Bitcoin Price Fetch together"),
    "put A and B together should read as a request to connect them"
  );
  for (const prose of [
    "track supply chain news headlines every morning",
    "put together a summary of my invoices",
    "summarize the supply chain report",
    "add a link to the article in the email",
  ]) {
    assert(
      !CHAIN_TALK_RE.test(prose),
      `chain talk must not fire on ordinary prose: ${prose}`
    );
  }
  assert(
    CHAIN_REQUEST_RE.test("make one for the price and one for the note, as a sequence"),
    "an explicit as-a-sequence build must set chain intent"
  );
  assert(
    CHAIN_REQUEST_RE.test(
      "make an automation for this and make an automation for this a chain"
    ),
    "the ask tacked onto the end must set chain intent"
  );
  assert(
    !CHAIN_REQUEST_RE.test("summarize the supply chain report"),
    "chain intent must not fire on topic prose"
  );
  assert(
    PLURAL_REF_RE.test("connect these") && !PLURAL_REF_RE.test("connect Bitcoin Price Check"),
    "plural pointers reach for the thread; explicit names do not"
  );
  assert(
    SEQUENCE_NAME_RE.exec("put them together and call it Morning Combo")?.[1] ===
      "Morning Combo",
    "a sequence name said in passing should be picked up"
  );
  assert(
    mentionIndex("connect Solana Watcher and Bitcoin Price", "Bitcoin Price") >
      mentionIndex("connect Solana Watcher and Bitcoin Price", "Solana Watcher"),
    "sequence order should follow the order the names were said"
  );
  for (const said of [
    "make a sequence from Solana Watcher and Solana Morning Check",
    "make a chain out of Bitcoin Price Fetch and Bitcoin Alert Message",
    "build a workflow from Bitcoin Price Check and Bitcoin Email Summary",
  ]) {
    assert(CHAIN_TALK_RE.test(said), `"make a sequence from A and B" should connect: ${said}`);
  }
  assert(
    !CHAIN_TALK_RE.test("make an automation that checks the price of litecoin"),
    "making an AUTOMATION must not read as making a sequence"
  );

  // ---- sequences of automations that do not exist yet ----
  for (const said of [
    "I want a sequence of the price of meta and the weather of orlando",
    "i want a chain of the tesla stock price and the top tech news",
    "give me a chain of the apple stock price and the seattle weather",
    "a sequence of the bitcoin price and the solana price",
  ]) {
    assert(
      CHAIN_REQUEST_RE.test(said),
      `a sequence of NEW jobs must set chain intent: ${said}`
    );
  }
  assert(
    !isCompactReadRequest({
      userText: "check the nvidia stock price and the weather in denver, as a sequence",
      answers: [],
    }),
    "the one-automation compact path must step aside for a sequence request"
  );
  const { orderByMention } = await server.ssrLoadModule("/src/pipeline/sequence.ts");
  const named = (name) => ({ id: name, name, inputs: [], outputs: [] });
  assert(
    orderByMention(
      [named("Top Tech News"), named("Tesla Stock Price")],
      "i want a chain of the tesla stock price and the top tech news"
    )
      .map((r) => r.name)
      .join(",") === "Tesla Stock Price,Top Tech News",
    "a sequence runs in the order the person said it, not template order"
  );
  const quickSeq = compile(
    "i want a sequence of the bitcoin price, the ethereum price and the solana price"
  );
  assert(quickSeq?.kind === "draft", "a 3-item sequence should still compile locally");
  assert(
    quickSeq.draft.automations.length === 3,
    "a sequence of three named things is three automations"
  );

  // ---- a stated hour is never quietly replaced ----
  const { editAutomation } = await server.ssrLoadModule("/src/pipeline/edit.ts");
  const baseRecord = {
    id: "auto-test", name: "T", sentence: "s", category: "c", steps: ["x"],
    inputs: [], outputs: [], files: { reads: [], writes: [] }, formats: {},
    sources: ["api.coingecko.com"], apps: [], tools: [], knowledge: [],
    delivers: "answer", schedule: { trigger: "manual" }, effort: "quick",
    model: "m", compiledBy: "m", origin: { kind: "told", at: 0 }, lastRun: null,
  };
  const sched = async (text) =>
    (await editAutomation({ ...baseRecord }, text)).after?.schedule;
  for (const [text, want] of [
    ["switch it to every day at 10", { trigger: "daily", hour: 10 }],
    ["set it to 7 every morning", { trigger: "daily", hour: 7 }],
    ["run it at 8 in the evening", { trigger: "daily", hour: 20 }],
    ["run it at 9 at night", { trigger: "daily", hour: 21 }],
    ["make it run every day at 9am", { trigger: "daily", hour: 9 }],
    ["change it to every 45 minutes", { trigger: "watch", everyMinutes: 45 }],
  ]) {
    const got = await sched(text);
    assert(
      JSON.stringify(got) === JSON.stringify(want),
      `"${text}" should schedule ${JSON.stringify(want)}, got ${JSON.stringify(got)}`
    );
  }

  console.log(`Quick regression suite passed (${assertionCount} assertions).`);
} finally {
  await server.close();
}
