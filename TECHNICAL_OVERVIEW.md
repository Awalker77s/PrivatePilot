# Technical Overview

A brief explanation of the problem Private Pilot solves, what it is built on, and how it actually works.

## The Problem

Plain-English automation tools exist, but nearly all of them work by shipping your request — and often your files, your screen, or your inbox — to someone else's server. That is a poor trade for exactly the tasks people most want automated: reading email, going through documents, touching anything personal.

There is a second cost. Most of these tools depend on a subscription or an API key, so the automation stops working the moment you stop paying for it.

Private Pilot runs the model on your own machine. No account, no API key, and nothing leaves the device unless you explicitly ask it to.

## The Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri v2 — Rust backend, native system webview rather than a bundled browser engine |
| Frontend | React + TypeScript |
| Local model | Ollama running `qwen3.5:4b` by default (3.3 GB, fits entirely on GPU) |
| Cloud model | Featherless, optional and off until you turn it on |
| Storage | Local disk only — automations, runs, and history never sync anywhere |

The local default is the point, not a fallback. Everything below exists to make a 4B model reliable enough to be the thing you actually use.

## How It Works

The core is a compiler, not a chat wrapper. A plain-English request becomes a strict-JSON automation record, and the runner executes that record.

**Schema-constrained decoding.** The JSON Schema for an automation is compiled into a llama.cpp grammar and passed through Ollama's `format` parameter. The model physically cannot emit invalid JSON — there is no parse-and-hope step, because malformed output is not a reachable state during sampling.

**A closed capability catalog.** Your real files, folders, and tools are baked into that schema as enums. If nothing is indexed, the catalog compiles to `{"not": {}}` — an impossible type. The model cannot name a file that does not exist, because the grammar will not let it produce one. This replaces hallucination-checking after the fact with hallucination being unrepresentable.

**A validating repair loop.** Drafts go through three passes. Between them, a repair stage fixes right-idea-wrong-shape output: a full URL where a hostname belongs, invented tools dropped, overflow steps folded into the last one. The final pass relaxes the strictest constraints so a near-miss becomes a working automation instead of an error.

**Chaining modeled on CI workflows.** Steps carry `after`, `needs: all | any`, `when: ran | held | broke | failed | always`, and conditions on the previous step's answer. That is enough to express real branching — "check my email, and if there's anything from the team, summarize it." Repetition is a re-armed watcher rather than a cycle in the graph, following the same reasoning Airflow and Temporal use to keep workflows acyclic.

**Coordination split in code, not in the model.** A 4B model is unreliable at planning several jobs at once. Multi-job requests are split deterministically before the model sees them, so it only ever handles one job at a time. This single decision is most of why a small local model is good enough to be the default.

## Safety and Permissions

Automations carry a permission manifest declaring which connectors, commands, and capabilities they use. Approval is bound to a content hash of the revision, so editing an automation makes it re-earn its approval rather than inheriting the old one.

Connectors are opt-in individually. File tools run against a sandbox root and reject paths that escape it. The Gmail connector uses an app password sealed with Windows DPAPI, and it drafts — it does not send.

## Local vs. Cloud

Both are supported, and the distinction is deliberate:

- **Local** — private by construction, free to run, works offline, no key required. The right default for anything involving your own data.
- **Cloud** — stronger and faster on hard reasoning. Worth reaching for on non-sensitive work, and it stays off until you provide a key.

The switch is per-request and visible, so you always know where a given automation is being compiled.
