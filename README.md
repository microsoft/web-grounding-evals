# FreshSearch Benchmark

**Measure the age of search evidence and retrieval of newly published feed articles.**

## Contents

- [1. Overview](#1-overview)
- [2. Dataset composition](#2-dataset-composition)
- [3. Quick start](#3-quick-start)
- [4. Step-by-step setup and evaluation](#4-step-by-step-setup-and-evaluation)
  - [4.1. Install and check your tools](#41-install-and-check-your-tools)
  - [4.2. Get the repository](#42-get-the-repository)
  - [4.3. Install dependencies and run the offline tests](#43-install-dependencies-and-run-the-offline-tests)
  - [4.4. Run, replay and view the offline examples](#44-run-replay-and-view-the-offline-examples)
  - [4.5. Confirm authorization and data handling](#45-confirm-authorization-and-data-handling)
  - [4.6. Configure your search providers](#46-configure-your-search-providers)
  - [4.7. Configure the EF judge](#47-configure-the-ef-judge)
  - [4.8. Run a small authorized live pilot](#48-run-a-small-authorized-live-pilot)
  - [4.9. Run the full authorized evaluation](#49-run-the-full-authorized-evaluation)
  - [4.10. Check completion and view results](#410-check-completion-and-view-results)
- [5. Understand the scores](#5-understand-the-scores)
- [6. Repository guide](#6-repository-guide)
- [7. Contributing and license](#7-contributing-and-license)

## 1. Overview

Grounding is supposed to keep AI current. Developers need to know whether a
search provider returns current evidence and finds newly published
information—not just whether it can answer familiar questions.

FreshSearch evaluates that gap through two complementary panels:

| Panel                             | What it measures                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------- |
| **Evidence Freshness (EF)**       | The age of source-supported evidence returned for time-sensitive questions        |
| **Fresh Content Discovery (FCD)** | Retrieval of the ten newest eligible items in a feed, weighted toward newer items |

A combined result uses 20% EF and 80% FCD when its cohort meets the
requirements in [Methodology](benchmark/METHODOLOGY.md#combined-score). Subsets
are exploratory. These scores do not establish current-answer correctness or
provider rankings.

## 2. Dataset composition

| Panel                   | Composition                                                                                    | Evaluation input                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Evidence Freshness      | 60 Finance tasks followed by 60 Weather tasks, with 20 head, torso and tail tasks per category | [`current-launch-ef120.json`](benchmark/datasets/current-launch-ef120.json) |
| Fresh Content Discovery | 96 selected feeds; four feeds with paywalled article links were excluded when assembled        | [`current-launch-fcd96.json`](benchmark/datasets/current-launch-fcd96.json) |

Head, torso and tail are broad tiers of common, intermediate and less common
entities; see [population and interpretation](benchmark/METHODOLOGY.md#population-and-interpretation)
for limits.

## 3. Quick start

Install [Node.js](https://nodejs.org/en/download) **22, 24 or 26** and npm.
Git is optional. Use this quick start **or** sections 4.1–4.4; you do not need
to clone and install twice.

Clone with Git:

```bash
git clone https://github.com/microsoft/grounding-evals.git
cd grounding-evals/benchmark
```

Or download and extract the GitHub ZIP, then enter its `benchmark` directory.
Windows Extract All may create an additional nested repository directory; if
so, enter that directory first. Then run:

```bash
npm ci --ignore-scripts
npm test
npm run smoke:ef
npm run smoke:fcd
```

These commands make **no search-provider, publisher or model calls**. The
examples are synthetic, not measured provider performance. Expect EF **62.5**
and FCD **51/93** points. Outputs are written to `local-runs/ef/` and
`local-runs/fcd/`.

Continue at **section 4.4** to replay and view the examples, or at
**section 4.5** before any live evaluation.

## 4. Step-by-step setup and evaluation

Start with the offline walkthrough. Continue to live evaluation only after
confirming authorization, obtaining provider access and configuring a
compatible judge.

### 4.1. Install and check your tools

Install [Node.js](https://nodejs.org/en/download) 22, 24 or 26. npm is
included; [Git](https://git-scm.com/downloads) is optional. Supported patch and
security updates do not require editing the benchmark.

Open Terminal on macOS/Linux or PowerShell on Windows:

```bash
node --version
npm --version
```

Weather runs record Node, ICU and timezone-data versions in their bindings;
replaying evidence requires its recorded runtime. Do not pool results with
different timezone semantics without a compatibility review or rebaseline.

### 4.2. Get the repository

Skip this step if you completed the quick start. Clone with Git, or download
the ZIP from GitHub and extract it:

```bash
git clone https://github.com/microsoft/grounding-evals.git
cd grounding-evals/benchmark
```

**Run all remaining commands from `benchmark/`.** No API server, web app,
Azure deployment or database is needed.

When sharing results, record the scorer `source.outputSha256` and policy
version from `results.json`; Git users can also record `git rev-parse HEAD`.

### 4.3. Install dependencies and run the offline tests

Skip this step if you completed the quick start.

```bash
npm ci --ignore-scripts
npm test
```

### 4.4. Run, replay and view the offline examples

Each command reads a synthetic capture, scores it and writes `results.json`,
`cases.csv`, `issues.csv` and `capture.json`. Output directories must be new:

```bash
node run.mjs --panel ef --input examples/ef.json --out local-runs/ef-first
node run.mjs --panel fcd --input examples/fcd.json --out local-runs/fcd-first
```

Synthetic captures replay without network access; scores and coverage should
match the originals:

```bash
node run.mjs --panel ef --input local-runs/ef-first/capture.json --out local-runs/ef-replay
node run.mjs --panel fcd --input local-runs/fcd-first/capture.json --out local-runs/fcd-replay
```

Generate and open an offline HTML report:

```bash
node report.mjs --run local-runs/ef-first --run local-runs/fcd-first --out local-runs/offline-results.html
```

Only synthetic fixtures are replayable. Live outputs are metadata-only (section 4.5).
See the [runner guide](benchmark/README.md) for all commands and options.

### 4.5. Confirm authorization and data handling

Before any live collection, verify that your provider, publisher and judge
agreements authorize the intended collection, transmission to the judge,
derived-score retention and any publication. Robots rules and inclusion in a
dataset are **not** content licenses. Do not run if the account's terms or
limits do not permit the proposed use and pacing.

Both `--live` and `--confirm-authorized-use` are required for live runs. The
latter is your affirmation; it does not grant rights.

The runner keeps provider responses, publisher material, prompts, judge
responses and shared FCD references in memory only for the run. Live output
files are metadata-only and **cannot replay** the underlying content. Scores,
configured identifiers, timings, fingerprints and reservation records still
require review before sharing.

Built-in search, publisher and judge requests ask HTTP caches not to store
responses, and EF judge requests set `store:false`. Neither guarantees that a
judge service or other infrastructure retains nothing. External providers,
custom adapters, network intermediaries, operating-system swap and logs may
have their own behavior; confirm their terms and controls separately.

### 4.6. Configure your search providers

Obtain credentials from each provider's account or API-access administrator.
The included adapters are offline contract-tested, not live-validated.

| Provider   | Adapter                    | Required setting     | Built-in endpoint                        |
| ---------- | -------------------------- | -------------------- | ---------------------------------------- |
| WebIQ      | `providers/webiq.mjs`      | `WEBIQ_API_KEY`      | `https://api.microsoft.ai/v3/search/web` |
| WebIQ Auto | `providers/webiq-auto.mjs` | `WEBIQ_API_KEY`      | `https://api.microsoft.ai/v3/auto`       |
| Exa Auto   | `providers/exa-auto.mjs`   | `EXA_API_KEY`        | Provider default                         |
| Parallel   | `providers/parallel.mjs`   | `PARALLEL_API_KEY`   | Provider default                         |
| Perplexity | `providers/perplexity.mjs` | `PERPLEXITY_API_KEY` | Provider default                         |

Microsoft develops WebIQ. Results depend on provider configuration, run time
and judge; they are not an official ranking.

Both WebIQ adapters call their built-in endpoints by default, like the other
adapters. Set `WEBIQ_ENDPOINT` or `WEBIQ_AUTO_ENDPOINT` only to override one
with another HTTPS URL; neither adapter falls back to the other's endpoint.
WebIQ and WebIQ Auto share one key and may share an account rate limit.

To bring your own provider, adapt [the example](benchmark/examples/provider.mjs)
and follow the [custom adapter contract](benchmark/README.md#provider-and-judge-setup).

Copy the settings template to `.env` only if `.env` does not already exist and
your credential policy permits storing keys in a file:

```bash
node -e "const fs=require('node:fs'); if(!fs.existsSync('.env')) fs.copyFileSync('.env.example','.env',fs.constants.COPYFILE_EXCL);"
```

Uncomment and fill in only the providers you plan to run, one `NAME="value"`
per line. Commands below load it with `node --env-file=.env`; variables
already set in your terminal take precedence. If your credentials are already
in the terminal environment, omit `--env-file=.env`. **Never commit `.env`.**

### 4.7. Configure the EF judge

EF needs an authorized judge with **strict JSON Schema** structured output.
FCD does not use an LLM judge.

#### Reference judge

The reference judge is **`gpt-5.6-sol`** with reasoning effort **`low`**,
using the [`azure-judge-config.json`](benchmark/examples/azure-judge-config.json)
template. Keep the judge identical across every provider in a comparison.

The runner fixes reasoning effort and per-call output limits; they are not
configurable. A reply that exhausts its output limit fails as
`judge-output-truncated` rather than being silently retried.

**A successful "return JSON" probe does not establish scoring compatibility.**
Confirm at least one _scored_ Weather task and one _scored_ Finance task in an
authorized pilot (section 4.8) before a full run; the categories use different
budgets and evidence shapes.

#### Other judges

Other models or transports produce results that are not comparable with the
reference configuration:

| Transport                          | Template                                                                                    | Notes                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| OpenAI-compatible Chat Completions | [`judge-config.json`](benchmark/examples/judge-config.json)                                 | Full `/chat/completions` URL and explicit model; key in `FRESHSEARCH_JUDGE_API_KEY`   |
| Azure OpenAI Responses             | [`azure-responses-judge-config.json`](benchmark/examples/azure-responses-judge-config.json) | Full `/openai/v1/responses` endpoint; no seed support, so not seeded-parity with Chat |

Copy the chosen template to an ignored local file without overwriting an
existing configuration, then replace its placeholders:

```bash
node -e "const fs=require('node:fs'); fs.copyFileSync('examples/azure-judge-config.json','local-judge.json',fs.constants.COPYFILE_EXCL);"
```

For Azure Chat Completions, set `model` to your deployment name and supply the
resource base URL through `AZURE_OPENAI_ENDPOINT` (in `.env` or the terminal)
or the configuration's `endpoint` field.

#### Enter your judge key

Never put the key in `local-judge.json`. The Azure templates read
`AZURE_OPENAI_KEY`; the OpenAI-compatible template reads
`FRESHSEARCH_JUDGE_API_KEY`. Hidden terminal input is recommended; `.env` is
acceptable only if your credential policy permits it.

**macOS/Linux**

```bash
set +x; set +v
printf 'Judge API key: '
IFS= read -r -s AZURE_OPENAI_KEY && export AZURE_OPENAI_KEY
printf '\n'
```

**Windows—PowerShell**

```powershell
Set-PSDebug -Off
$key = Read-Host 'Judge API key' -AsSecureString
$env:AZURE_OPENAI_KEY = [System.Net.NetworkCredential]::new('', $key).Password
Remove-Variable key
```

For the OpenAI-compatible template, substitute `FRESHSEARCH_JUDGE_API_KEY`.
Continue in the same terminal.

### 4.8. Run a small authorized live pilot

List the feed IDs, publisher names and feed URLs offline:

```bash
node -e "const c=require('./datasets/current-launch-fcd96.json'); console.table(c.sources.map(s=>({sourceId:s.sourceId,publisher:s.contract.publisherName,feedUrl:s.contract.reference.feedUrl})))"
```

Select a feed you are authorized to evaluate. The pilot uses WebIQ Auto and the
sample Weather task in `examples/ef-tasks.json`; configure `WEBIQ_API_KEY` or
substitute another authorized adapter. This task is not an EF120 task.

Replace every placeholder before running. Choose a `--search-delay-ms` pacing
that meets every selected account's documented limits; there is no universal
safe interval.

**Windows—PowerShell**

```powershell
node --env-file=.env evaluate.mjs --live --confirm-authorized-use `
  --provider providers\webiq-auto.mjs --fcd-feed-id YOUR_AUTHORIZED_FEED_ID `
  --ef-input examples\ef-tasks.json --judge-config local-judge.json `
  --max-fcd-calls 10 --max-ef-calls 1 --max-judge-calls YOUR_APPROVED_JUDGE_LIMIT `
  --search-delay-ms YOUR_DOCUMENTED_MINIMUM_MS --out local-runs\live-pilot
```

**macOS/Linux**

```bash
node --env-file=.env evaluate.mjs --live --confirm-authorized-use \
  --provider providers/webiq-auto.mjs --fcd-feed-id YOUR_AUTHORIZED_FEED_ID \
  --ef-input examples/ef-tasks.json --judge-config local-judge.json \
  --max-fcd-calls 10 --max-ef-calls 1 --max-judge-calls YOUR_APPROVED_JUDGE_LIMIT \
  --search-delay-ms YOUR_DOCUMENTED_MINIMUM_MS --out local-runs/live-pilot
```

The launcher prints progress to the terminal and writes
`local-runs/live-pilot/results.html`. Check completion and coverage using
section 4.10. **A held FCD feed does not establish adapter compatibility; a
held or unscored EF task does not establish judge compatibility.** Review any
failure category and reconcile usage before retrying into a new output
directory.

### 4.9. Run the full authorized evaluation

The full cohort contains **120 EF tasks and 96 FCD feeds**. Removing feeds or
tasks produces an exploratory subset.

Prepare the ordered feed list offline, then retain only your authorized
selection in the original order:

```bash
node -e "const fs=require('node:fs'); const c=JSON.parse(fs.readFileSync('datasets/current-launch-fcd96.json','utf8')); fs.writeFileSync('approved-fcd-feeds.txt',c.sources.map(s=>s.sourceId).join('\n')+'\n',{flag:'wx'});"
```

Omit `--ef-input` to use EF120, or `--all-fcd-feeds` instead of
`--fcd-feeds` if every feed is authorized. Remove any `--provider` you do not
intend to run.

**macOS/Linux**

```bash
node --env-file=.env evaluate.mjs --live --confirm-authorized-use \
  --provider providers/webiq.mjs \
  --provider providers/webiq-auto.mjs \
  --provider providers/exa-auto.mjs \
  --provider providers/parallel.mjs \
  --provider providers/perplexity.mjs \
  --fcd-feeds approved-fcd-feeds.txt \
  --judge-config local-judge.json \
  --max-fcd-calls 4800 --max-ef-calls 600 \
  --max-judge-calls YOUR_APPROVED_JUDGE_LIMIT \
  --search-delay-ms YOUR_DOCUMENTED_MINIMUM_MS \
  --out local-runs/full-01
```

**Windows—PowerShell**

```powershell
node --env-file=.env evaluate.mjs --live --confirm-authorized-use `
  --provider providers\webiq.mjs `
  --provider providers\webiq-auto.mjs `
  --provider providers\exa-auto.mjs `
  --provider providers\parallel.mjs `
  --provider providers\perplexity.mjs `
  --fcd-feeds approved-fcd-feeds.txt `
  --judge-config local-judge.json `
  --max-fcd-calls 4800 --max-ef-calls 600 `
  --max-judge-calls YOUR_APPROVED_JUDGE_LIMIT `
  --search-delay-ms YOUR_DOCUMENTED_MINIMUM_MS `
  --out local-runs\full-01
```

PowerShell continuation backticks must be the final character on their lines.
Use `--ef-only` or `--fcd-only` with only that panel's inputs and budgets to
run one panel. Consider one provider per run to limit repeated paid work after
a failure; there is no resume.

#### Budgets

| Allowance    | Calculation for five providers                                                            |
| ------------ | ----------------------------------------------------------------------------------------- |
| FCD searches | 96 feeds × 5 providers × 10 targets = **4,800**                                           |
| EF searches  | 120 tasks × 5 providers = **600**                                                         |
| Judge calls  | At least 2 per task/provider (**1,200**) are preflighted; set the limit you have approved |

Confirmed-clock extraction, confirmation and repair can need several judge
calls **per returned source**, so no fixed per-task maximum exists. An
exhausted budget stops the run. Budgets cap attempts, **not dollars**.
Publisher requests are separate: each feed/provider qualification is
capped at 24 publisher requests, including redirects. Interrupted calls may
have incurred charges.

#### Pacing, timing and market windows

- **Pacing.** Choose pacing that meets every selected account's documented
  limits; there is no universal safe interval. `--search-delay-ms` accepts
  0–60000 (default 0). It paces search invocations only, not publisher or
  judge requests, and does not adaptively back off from rate-limit errors.
  Account for shared quotas (WebIQ and WebIQ Auto may share one) and other
  traffic. Do not run if the account's restrictions cannot be met.
- **FCD timing.** Each feed's live run has a **five-minute execution
  deadline**, covering reference capture and every provider search. Provider
  searches are admitted only while the shared reference is at most
  five minutes old. Each provider search must then return before the earliest of:
  ten minutes after reference capture, one minute before the execution
  deadline, and the feed's age-band limit. Each search attempt times out
  after at most two minutes. Targets that miss a deadline are recorded as
  held, not scored, so long pacing intervals can leave targets unavailable.
  Never shorten an account-required interval to force a score.
- **Finance window.** Finance tasks run from **10:00 inclusive to 16:00
  exclusive New York time** on exchange trading days, with **13:00 early
  closes** on listed days; holidays apply and the bundled calendar covers
  **2026–2028**. Outside the window tasks are held.
- **Order.** Combined runs execute **EF before FCD**. The default EF120
  dataset runs **Finance before Weather**; custom `--ef-input` files keep their
  order. Start early enough for all providers, pacing and judge calls:
  EF-first ordering does not guarantee completion before the window closes.

#### Failures and partial runs

By default the first failed assignment stops the run, leaves later
assignments pending and withholds the combined score. The terminal error,
`evaluation.json` and `summary.json` record a sanitized category, panel, task
or feed, provider and call counts. The failed assignment's `failure.json`
holds only its status, reason, message and hint. None of these include raw
provider or judge content. `--continue-after-failure` records classified
failures and continues; the run then ends with status `partial`, exit code 2
and coverage beside every score. See
[failures, partial runs and progress](benchmark/README.md#failures-partial-runs-and-progress).

### 4.10. Check completion and view results

Print the final summary:

```bash
node -e "console.log(JSON.stringify(require('./local-runs/full-01/summary.json'),null,2))"
```

For the pilot, substitute `local-runs/live-pilot/summary.json`. Successful
processing has `status` equal to `"complete"`, `completed` equal to
`assigned`, and `failed`, `skipped` and `pending` equal to `0`. A `partial`
or `failed` status is never a complete result.

These fields describe processing, not whether every opportunity received a
score. Review each panel's score beside its scored, held and coverage counts.
A complete evaluation can still contain unscored opportunities or a panel with
no numeric score.

Open `local-runs/full-01/results.html` in your browser. The launcher updates
it during execution; interrupted, failed and partial runs remain marked.

Live outputs are metadata-only and cannot be replayed. Endpoint hosts may
appear in configuration fingerprints and inputs; review and scrub identifiers
before sharing any output.

## 5. Understand the scores

### Evidence Freshness

EF scores supported evidence against the question's request time. Evidence
receives full credit at or below the category's freshness window, then decays
with age. No truth fetch is made, so the score includes source publication lag.

| Category | Full-credit window | Half-life afterward |
| -------- | -----------------: | ------------------: |
| Weather  |         30 minutes |          60 minutes |
| Finance  |          5 minutes |          15 minutes |

EF is the mean of the category/tier **cell means**, not of uneven tasks.
Held tasks are unscored, not zero. This is not an independent current-fact
correctness benchmark.

### Fresh Content Discovery

FCD searches for the ten newest eligible items per feed, with no maximum age.
A hit requires a matching target URL or an accepted canonical alias. Upper
age-band boundaries are exclusive.

| Article age at the original reference time | Possible points |
| ------------------------------------------ | --------------: |
| Under 30 minutes                           |              15 |
| 30 minutes to under 1 hour                 |              10 |
| 1 hour to under 6 hours                    |               5 |
| 6 hours to under 24 hours                  |               2 |
| 24 hours or older                          |               1 |

**FCD score = 100 × earned hit points ÷ possible points for eligible targets.**
An eligible target whose provider is unavailable earns zero but stays in the
denominator.

See [Methodology](benchmark/METHODOLOGY.md) for exact scoring, exclusion and
combined-score rules.

## 6. Repository guide

| Location                                                             | Purpose                                          |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| [`benchmark/run.mjs`](benchmark/run.mjs)                             | Single-panel execution and synthetic replay      |
| [`benchmark/evaluate.mjs`](benchmark/evaluate.mjs)                   | Matched multi-provider evaluation                |
| [`benchmark/evaluation-report.mjs`](benchmark/evaluation-report.mjs) | Evaluation summaries and HTML output             |
| [`benchmark/providers/`](benchmark/providers/)                       | Provider adapters and contract tests             |
| [`benchmark/examples/`](benchmark/examples/)                         | Synthetic captures, sample task, judge templates |
| [`benchmark/datasets/`](benchmark/datasets/)                         | Launch datasets and provenance metadata          |
| [`benchmark/README.md`](benchmark/README.md)                         | Runner, budgets, failures and output reference   |
| [`benchmark/METHODOLOGY.md`](benchmark/METHODOLOGY.md)               | Scoring, denominators and comparability          |
| [`docs/`](docs/)                                                     | Third-party dependency license information       |

## 7. Contributing and license

See [contribution guidance](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md),
[support](SUPPORT.md) and [security reporting](SECURITY.md).

Microsoft-authored code is provided under the [MIT license](LICENSE).
Bundled third-party components retain their own licenses; see [NOTICE](NOTICE).
These licenses do not grant rights to publisher content or provider responses.

### Telemetry and data collection

This toolkit contains no telemetry. Live evaluation sends queries and evidence
to the selected providers and EF judge, and fetches publisher robots.txt, feeds
and articles directly using the `FreshSearchBenchmark` crawler token.

### Trademarks

This project may contain trademarks or logos for projects, products or
services. Authorized use of Microsoft trademarks or logos is subject to and
must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks).
Use of Microsoft trademarks or logos in modified versions of this project must
not cause confusion or imply Microsoft sponsorship. Use of third-party
trademarks or logos is subject to those third parties' policies.
