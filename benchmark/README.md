# FreshSearch runner

The standalone runner provides Evidence Freshness (EF), Fresh Content Discovery
(FCD), an evaluation launcher and an offline HTML viewer. No web application,
database or Azure deployment is needed for the synthetic examples.

Node 22, 24 and 26 are supported, including patch and security updates. Weather
contracts and execution receipts record the actual Node, ICU and timezone data.
Replay requires the recorded runtime; review timezone compatibility or rebaseline
before comparing runs across different runtime identities.

## Offline examples

From `benchmark/`, run `npm ci --ignore-scripts`, `npm test`,
`npm run smoke:ef` and `npm run smoke:fcd`. The examples are synthetic; their EF score is
62.5 and FCD earns 51/93 points. Output directories must not already exist.

```powershell
node run.mjs --panel ef --input examples\ef.json --out local-runs\ef-second
node run.mjs --panel fcd --input examples\fcd.json --out local-runs\fcd-second
node run.mjs --panel ef --input local-runs\ef-second\capture.json --out local-runs\ef-replay
node report.mjs --run local-runs\ef-second --run local-runs\fcd-second --out local-runs\results.html
```

Only synthetic captures are written with replayable evidence by the runner.
Keep each future capture's original scorer and bindings for replay; do not
replace its recorded hashes. The legacy EF scoring path accepts only
explicitly synthetic fixtures. A synthetic label is not proof of provenance.
The offline viewer reports independent panel observations separately; it does
not combine unrelated runs. See `node run.mjs --help`,
`node evaluate.mjs --help` and `node report.mjs --help`.

`npm run smoke:clean` runs the full public benchmark test selection in a
temporary dependency-free copy, checks the synthetic fixture reports and
byte-identical replay, and generates the offline viewer. It makes no live calls.

## Rights and retention

Before live execution, verify account-specific rights for provider queries,
publisher access, sending evidence to the selected judge, storing derived
scores and sharing results. Robots and page directives are checked but are
not licenses. Each live command requires both `--live` and
`--confirm-authorized-use`; the latter is an affirmation, not permission.

The runner holds provider responses, publisher feed/article data, task text,
prompts, judge responses and FCD references in memory only while processing.
Live output and failure checkpoints contain metadata rather than those payloads:
scores, safe identifiers, timestamps, timings, source hashes, keyed configuration
fingerprints, call budgets and reservation states. The output is **not
replayable**. Treat even this metadata as potentially sensitive and check
publication rights. A retained input imported for offline scoring is also
projected to metadata-only output unless explicitly marked synthetic.

Built-in search, publisher and judge requests send `Cache-Control: no-store`,
and judge requests set `store:false`. These do not prove that a
service has no retention. Provider and judge services, third-party adapters,
host logging, network systems and operating-system swap may retain information
independently. Review their contracts and configuration.

## Provider and judge setup

Adapters and required environment variables are listed in the [root guide](../README.md#46-configure-your-search-providers).
Built-in adapters use a single search request without retry or fallback; live
provider compatibility has not been established by offline tests.

Copy `.env.example` to a new `.env` only when permitted by your credential
policy. Node loads it only with `node --env-file=.env`; existing environment
variables take precedence. Never put keys in a judge JSON file or commit them.

The recommended confirmed-clock EF judge is **`gpt-5.6-sol`**. For an
OpenAI-compatible endpoint, set `model` to that model; for Azure, use the
actual deployment name serving it. Keep the model version, transport and
judge settings fixed across provider arms. FCD does not use an LLM judge.

For EF, copy `examples/judge-config.json` for an OpenAI-compatible Chat
Completions endpoint or `examples/azure-judge-config.json` for Azure Chat
Completions. Supply the specified key through the environment and configure
an explicit model or deployment supporting strict JSON Schema. Azure Responses
uses `examples/azure-responses-judge-config.json` with the full
`/openai/v1/responses` endpoint. Responses does not support a seed; its strict
schema, low reasoning effort, token budget and `store:false` are retained.
Transport-specific request hashes and configuration bindings prevent claiming
seeded Chat/Responses parity. No endpoint or model is claimed to be live-validated.
In an authorized pilot, confirm a scored EF task: held/unscored tasks do not
establish judge compatibility, and a held FCD feed does not verify its adapter.

Custom adapters export `providerId`, `physicalRetries = 0`, and `search` for
FCD. EF additionally requires `searchFullResponse`, which must use the
full-response capture contract illustrated by the built-in adapters. They
must honor the signal and report malformed responses as errors. A custom
adapter controls its own credentials, logging and retention.

## Live execution after approval

The following are command shapes, not authorization for live collection.
Replace every placeholder only after rights, credentials and account limits
are resolved.

```powershell
node --env-file=.env evaluate.mjs --live --confirm-authorized-use `
  --provider providers\webiq-auto.mjs --fcd-feed-id YOUR_AUTHORIZED_FEED_ID `
  --ef-input examples\ef-tasks.json --judge-config local-judge.json `
  --max-fcd-calls 10 --max-ef-calls 1 --max-judge-calls YOUR_APPROVED_JUDGE_LIMIT `
  --search-delay-ms YOUR_ACCOUNT_INTERVAL_MS --out local-runs\pilot
```

The pilot contains one EF task, so it cannot produce a complete combined
score. Select `--fcd-only` or `--ef-only` for one panel; omit the other
panel's flags and limits. For FCD choose exactly one of `--fcd-feed-id`,
`--fcd-feeds` (one approved feed ID per UTF-8 line) or `--all-fcd-feeds`
(only if all feeds are authorized). Repeat `--provider` for each selected
adapter. `--ef-input` defaults to the full 120-task launch dataset.

The checked-in feed catalog can be edited for a custom cohort; the fixed
launch-dataset integrity checks then no longer apply. Custom results are not
the original launch benchmark.

For single-panel commands use `run.mjs --panel ef|fcd --live
--confirm-authorized-use`; inspect its `--help` for the relevant flags. All
output directories must be new.

### Budgets and deadlines

- FCD requires a search allowance of ten per selected feed and provider;
  EF requires one search allowance per task and provider. The launcher
  preflights a minimum of two judge attempts per task, but actual confirmed
  clock judgments can require several calls **per returned source**, including
  extraction, confirmation and possible repairs. There is no four-call
  per-task guarantee. An exhausted budget stops the run.
- Limits cap search and judge attempts, **not dollars**. Publisher/reference
  requests are separate; each feed/provider qualification is capped at 24
  publisher requests, including redirects. Reservations are checkpointed before dispatch; an
  interrupted call may have incurred charges. There is no automatic replay or
  redispatch; reconcile usage before starting another run.
- `--search-delay-ms` is 0–60000 and defaults to zero. It paces search
  invocations, not all publisher and judge requests, and does not provide
  adaptive backoff. Choose pacing that meets every selected account's
  documented limits, including shared quotas and other traffic; there is no
  universal safe interval.
- Each FCD feed's live run has a five-minute execution deadline covering
  reference capture and all provider searches. The provider lane is admitted
  only while the shared reference is at most five minutes old; otherwise
  targets are held as `reference-window-expired`. Each target search must
  return before the earliest of ten minutes after reference capture
  (`capture-window-expired`), one minute before the execution deadline
  (`worker-settlement-window`) and the feed's age-band limit
  (`scoring-age-band-expired`). Each search attempt times out after the
  lesser of two minutes or the time remaining. Qualification, latency and
  pacing consume that time; a required interval can leave targets
  unavailable. Never shorten an account-required interval to force a score.
- EF Finance tasks have a New York trading-day window and early-close rules;
  the bundled calendar covers 2026–2028. Combined execution runs EF before
  FCD, with Finance before Weather in the default EF120 dataset. Custom
  `--ef-input` task order is preserved. Allow time for all providers, pacing
  and judge calls; Finance can still be held if its window closes.
  The window is 10:00 inclusive to 16:00 exclusive New York time, or 13:00
  on listed early-close days. Holidays apply. Because target searches must
  settle at least one minute before the five-minute execution deadline, nine
  search delays over about 26 seconds cannot fit even without qualification
  and request latency.

### Judge failures

The confirmed-clock profile caps each Weather completion at **1,024 output
tokens** and each Finance completion at **2,000**. For reasoning models, that
allowance includes reasoning tokens. `--max-judge-calls` controls the number
of attempts, not the output-token limit.

`judge-output-truncated` means a reply exhausted that output allowance. Check
that the configured model, or the model behind your Azure deployment, is the
recommended `gpt-5.6-sol`. Changing the model does not itself establish
compatibility: confirm a scored EF task in an authorized pilot before a full
run. Do not silently raise the profile's token limits or retry the same
configuration unchanged.

By default a judge failure stops execution, leaves later assignments pending and
withholds the complete combined score (see
[Failures, partial runs and progress](#failures-partial-runs-and-progress) for
the opt-in alternative). Successful tasks from an interrupted
run are partial results, not a valid complete EF score; failed tasks are not
dropped from the assignment count. The terminal, the failed assignment's
`failure.json` and the launcher's `evaluation.json` retain the sanitized
reason without raw judge replies or provider content. Reconcile reserved
calls, including potentially charged failures, before another run.

### Failures, partial runs and progress

Every failure is recorded with a sanitized category, the panel, EF category
(finance/weather), task `queryId` or FCD `feedId`, provider ID, call counts
(search used/allowed; for EF, judge used/allotted) and a remediation hint. The
same fields appear in the terminal error, `evaluation.json`, `summary.json`
(`failures`) and `results.html`. Raw provider responses, judge output,
evidence text, URLs and keys are never included.

| Category                                                                                    | Meaning                                                                                                          | Remediation                                                                                                 |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `provider-transport-failed`                                                                 | EF search request failed in transit (network error, reset or timeout, including while reading the response body) | Check connectivity and provider status. In FCD the target is recorded as unavailable and capture continues. |
| `judge-transport-failed`                                                                    | Judge request failed in transit (network error, reset or timeout)                                                | Check the judge endpoint, network and `timeoutMs`.                                                          |
| `judge-http-<status>`                                                                       | Judge returned an HTTP error, e.g. `judge-http-429`                                                              | 401/403/404: check key, endpoint and model; others: check status, quota or rate limits.                     |
| `judge-output-truncated`                                                                    | Judge output exceeded the fixed per-call budget (Weather 1,024 / Finance 2,000 tokens)                           | Use the reference judge or a model that fits the budget.                                                    |
| `judge-schema-rejected`                                                                     | Judge refused, returned no JSON, or failed JSON/schema validation                                                | The judge must support strict JSON Schema structured output.                                                |
| `judge-evidence-not-verbatim`                                                               | Judge quote or locator is not present verbatim in the returned evidence                                          | Use the reference judge or a model that quotes evidence verbatim.                                           |
| `http-<status>`                                                                             | Search provider returned an HTTP error                                                                           | Check the provider key, quota or rate limits.                                                               |
| `call-budget-exhausted`, `configuration-error`, `evaluation-integrity-error`, `interrupted` | Budget, credential/configuration, integrity check or cancellation                                                | Raise the budget, fix the named setting, rerun into a new `--out`, or reconcile and retry.                  |
| `collection-or-validation-failed`                                                           | Any other (unclassified) failure                                                                                 | Inspect the metadata-only checkpoint, reconcile reserved calls and retry.                                   |

**Fail-fast is the default.** The first failed assignment stops the run with
status `failed` (or `interrupted`), and later assignments stay `pending`.

**`--continue-after-failure`** (opt-in) records a failed assignment and moves
on, but only for `provider-transport-failed`, `judge-transport-failed`,
`judge-http-408/409/429/5xx`, `judge-output-truncated`,
`judge-schema-rejected` and `judge-evidence-not-verbatim`. The run still stops
on interruption, an exhausted budget, credential or configuration errors
(including `judge-http-401/403/404`), integrity failures and unclassified
errors.

- Judge accounting is conservative. A failed EF task's judge calls are read
  from its checkpoint. If they cannot be read, the task's whole judge
  allotment is deducted. `--max-judge-calls` is never exceeded.
- FCD providers for one feed share one reference. If a feed fails before any
  reference exists, the feed's remaining providers are marked `skipped`
  (`fcd-reference-unavailable`) rather than given a different reference.
  Once a reference exists, later providers keep using it.
- The run is `complete` only if every assignment completed; otherwise it is
  `partial`. A partial run still prints the launcher's final JSON line on
  stdout, then
  writes a one-line failed/skipped summary to stderr and **exits with code
  2**.
- `summary.json` reports `status`, `assigned`, `completed`, `failed`,
  `skipped`, `pending` and `coverage` (completed/assigned per panel and per
  provider). `results.html` shows a PARTIAL/FAILED banner, coverage beside
  every panel score (e.g. `EF 118/120 tasks`) and lists failed assignments.
  The combined score stays `incomplete` unless the run is complete.

**Progress.** `evaluate.mjs` writes one line to stderr when each assignment
starts and finishes, for example
`[12/216] EF finance · webiq-auto · <queryId> … complete | done 11 · failed 0 · skipped 0 | judge 34/2400`
(FCD lines show `FCD · <provider> · <feedId>`; the judge counter appears
whenever EF is selected). Stdout carries one JSON summary line per completed
assignment, followed by the launcher's final JSON line (`status`, `output`,
`report`). `--quiet` suppresses progress lines.

## Reports and methodology

`evaluation.json`, `summary.json` and `results.html` record the selected
assignments and panel summaries; per-assignment directories hold metadata-only
reports, checkpoints, CSV rows and failure receipts. FCD uses one in-memory
original reference per feed shared across provider lanes. EF combines
category/tier cell averages, not an unweighted average of uneven tasks.

A combined score appears only when the selected execution is complete, all
six Weather/Finance tier cells are present and scored, eligible FCD targets
exist, and reference/policy bindings match. A complete subset remains
exploratory; it is not the full launch cohort. Failure, cancellation,
missing panels or missing eligible targets do not become zero. An eligible
FCD target whose provider is unavailable does contribute zero earned points
to the reliability denominator.

See [Methodology](METHODOLOGY.md) for formulas, population and limitations.
The runner-generated HTML is an offline snapshot. It does not contain raw
provider responses, publisher content, prompts, judge responses, endpoints or
credentials. Verify identifiers and derived scores before sharing it.
