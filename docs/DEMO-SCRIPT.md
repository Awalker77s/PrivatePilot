# 3-minute demo script

The rubric gives the video 10 points for being **concise, showing live
execution, and explaining the architecture**. That is three things, and the
clock is 180 seconds — so every shot below does one of them, and nothing else
gets in.

**Before you record**
- Ollama running, `qwen3.5:4b` pulled, app already open on the Chat tab.
- **Clear chat** so the thread starts empty.
- Have `docs/ARCHITECTURE.md` open in a second window (for the 0:35 shot) —
  the system diagram renders on GitHub, so a browser tab works too.
- Record at 1920×1080. Speak over it; don't read the words on screen aloud.
- One take is fine. If a local run is slow, cut the dead air in editing —
  judges are watching for *it works*, not for real-time honesty about CPU.

---

## 0:00–0:20 · The problem, in one breath

**Show:** the app's empty Chat tab.

> "Every automation tool wants your files and your data in their cloud. I
> wanted the opposite: describe a job in plain English, have a model that runs
> on *my* machine turn it into something I can read, and watch it run — with
> nothing leaving the computer unless I say so. That's Private Pilot."

*Why this shot: names the problem and the target user in 20 seconds. Judges
score "solves a real problem for clear users" — say it, don't imply it.*

---

## 0:20–0:35 · One sentence becomes a readable automation

**Do:** type `check the current price of bitcoin and tell me the 24 hour change`
and send.

**Say, while it compiles:**

> "The local model isn't answering me — it's compiling. What comes back is an
> automation record: a name, the steps, and the one website it's allowed to
> touch. I can read it before it ever runs."

**Show:** the built card. Point the cursor at the sources line.

---

## 0:35–1:00 · The architecture, over the diagram

**Show:** `docs/ARCHITECTURE.md` system diagram.

> "Three ideas make that safe. First, a closed catalog: the app lists the real
> files and hosts and bakes them into the JSON schema, so the model *cannot*
> name a file that doesn't exist. Second, that schema is compiled to a decoding
> grammar — invalid JSON is unrepresentable, not just discouraged — and a
> validator loop corrects the draft up to three times. Third, at run time the
> fence is a function in code, not an instruction in a prompt."

*Why this shot: the rubric explicitly wants architecture explained. 25 seconds
on the diagram is the single highest-value block in the video.*

---

## 1:00–1:25 · Live execution, and the honesty layer

**Do:** press **Try it once**. Let it run.

**Say:**

> "Now it runs, watched. It fetches, and then every number in the answer is
> checked against the data that actually came back — if a figure isn't in the
> source, the run stops instead of guessing. That's the difference between an
> automation that reports and one that makes things up."

**Show:** the answer bubble with the real price.

---

## 1:25–1:50 · Sequences, in plain words

**Do:** type `connect Bitcoin Price Fetch and Bitcoin Morning Note` (use two
automations you actually have) and send. Then press **Try it once**.

**Say:**

> "Chains are usually a node graph you drag. Here you just say it. It wires the
> first job's output into the second's input, runs them in order, and each step
> answers in its own bubble."

---

## 1:50–2:15 · Files, sandboxed — the part people fear

**Do:** ask `summarize everything in my <folder> folder` on a folder with a few
PDFs. Let it run.

**Say:**

> "It reads PDFs, spreadsheets and notes the same way — and anything that
> *changes* files happens in a copy first. You get a diff and a Keep button, so
> a wrong automation costs a click, not a restore from backup."

---

## 2:15–2:40 · Local by default, cloud by choice (Featherless)

**Show:** the brain picker in the composer, then Settings → the Featherless
card.

> "Everything so far ran on my laptop. If I want a bigger model, I paste a
> Featherless key and pick one of their models — the same pipeline, the same
> schema contract, just a different brain. It's off by default, the key is
> sealed with Windows DPAPI, and every run records where it ran, so the app can
> always answer 'did this leave my computer?'"

*Why this shot: the rubric names Featherless.ai integration explicitly. Show
it working, and show that it's honest about compute location.*

---

## 2:40–3:00 · Close

**Show:** the Activity tab, scrolling past real run receipts.

> "Every run leaves a receipt — what it read, what it did, where it ran. It's
> a Tauri app: React and TypeScript in front, Rust underneath, about 26,000
> lines. Local-first automation that you can actually read. Thanks for
> watching."

---

## If you only have 90 seconds

Keep 0:00–0:20 (problem), 0:35–1:00 (architecture), 1:00–1:25 (live run),
2:15–2:40 (Featherless). Drop sequences and files. The four blocks that remain
are exactly the four things the rubric scores.

## Recording checklist

- [ ] Chat cleared, no leftover error strip at the top of the window
- [ ] Ollama warm — run one throwaway request before recording so the first
      model load isn't in the take
- [ ] The Featherless key pasted but cloud left OFF until that shot
- [ ] Video is **public** (unlisted is fine on YouTube; check the link in a
      private window before submitting — a private video scores zero)
- [ ] Under 3:00. Check the final export, not your edit timeline.
