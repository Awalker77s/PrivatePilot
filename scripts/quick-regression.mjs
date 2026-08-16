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
  const { tryQuickFileCompile } = await server.ssrLoadModule(
    "/src/pipeline/fileQuickDraft.ts"
  );
  const { parseQuickReadAll, parseQuickToolStep } = await server.ssrLoadModule(
    "/src/runner/quickSteps.ts"
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

  // ---- instant grounded file jobs ----
  const playgroundRoot = "C:\\Developer\\GitHub\\PrivatePilot\\test-data\\automation-playground";
  const playgroundCatalog = {
    folders: [
      {
        display: "~/…/automation-playground",
        real: playgroundRoot,
        label: "automation-playground",
        readable: true,
      },
      {
        display: "~/…/automation-playground/Inbox",
        real: `${playgroundRoot}\\Inbox`,
        label: "Inbox",
        readable: true,
      },
      {
        display: "~/…/automation-playground/Sorted/Invoices",
        real: `${playgroundRoot}\\Sorted\\Invoices`,
        label: "Invoices",
        readable: true,
      },
    ],
    files: [
      {
        display: "~/…/automation-playground/Inbox/Invoice ACME 1042.pdf",
        real: `${playgroundRoot}\\Inbox\\Invoice ACME 1042.pdf`,
        name: "Invoice ACME 1042.pdf",
        ext: "pdf",
        folderDisplay: "~/…/automation-playground/Inbox",
      },
    ],
    automationNames: [],
    readTargets: [
      "~/…/automation-playground",
      "~/…/automation-playground/Inbox",
      "~/…/automation-playground/Sorted/Invoices",
      "~/…/automation-playground/Inbox/Invoice ACME 1042.pdf",
    ],
    writeTargets: [
      "~/…/automation-playground",
      "~/…/automation-playground/Inbox",
      "~/…/automation-playground/Sorted/Invoices",
      "~/…/automation-playground/Inbox/Invoice ACME 1042.pdf",
    ],
    displayToReal: {},
    apps: [],
    knowledgeBases: [],
  };
  const fileCompile = (userText) =>
    tryQuickFileCompile(
      { userText, answers: [], history: undefined },
      playgroundCatalog
    );

  const folderSummary = fileCompile(
    `Make an automation that summarizes the test folder in this folder path ${playgroundRoot}`
  );
  assert(folderSummary?.kind === "draft", "an exact folder path should compile locally");
  assert(
    parseQuickReadAll(folderSummary.draft.automations[0].steps[0]) ===
      "~/…/automation-playground",
    "the folder summary should encode the cataloged root"
  );

  const namedFile = fileCompile("Summarize Invoice ACME 1042.pdf");
  assert(namedFile?.kind === "draft", "a cataloged filename should compile locally");
  assert(
    namedFile.draft.automations[0].files.reads[0].endsWith("Invoice ACME 1042.pdf"),
    "the filename summary should fence the exact file"
  );

  const renameFiles = fileCompile(
    "Rename every PDF in Inbox to sample-invoice-{n}{ext}"
  );
  assert(renameFiles?.kind === "draft", "a patterned rename should compile locally");
  assert(
    parseQuickToolStep(renameFiles.draft.automations[0].steps[0])?.tool ===
      "bulk_rename",
    "the rename should encode one deterministic bulk_rename call"
  );

  const moveFiles = fileCompile("Move every PDF from Inbox to Invoices");
  assert(moveFiles?.kind === "draft", "a two-folder move should compile locally");
  const moveStep = parseQuickToolStep(moveFiles.draft.automations[0].steps[0]);
  assert(moveStep?.tool === "move_files", "the move should encode move_files");
  assert(
    moveStep?.args.destination_folder ===
      "~/…/automation-playground/Sorted/Invoices",
    "the move destination should be the named catalog folder"
  );

  const missingFile = fileCompile("Summarize quarterly-plan-unknown.docx");
  assert(
    missingFile?.kind === "question" && missingFile.question.kind === "file",
    "an unknown filename should ask with real file choices instead of calling the model"
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

  console.log(`Quick regression suite passed (${assertionCount} assertions).`);
} finally {
  await server.close();
}
