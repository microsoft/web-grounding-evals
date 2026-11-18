# FreshSearch methodology

FreshSearch evaluates Evidence Freshness (EF) and Fresh Content Discovery
(FCD). The public runner uses the committed scorer bundles and records their
hashes. Offline regression tests cover selected scoring and capture cases;
they do not establish live judge accuracy, provider conformance or legal permission.

## Population and interpretation

The fixed launch selection contains 60 Finance and 60 Weather tasks, with
20 head, torso and tail tasks per category, plus 96 selected publisher feeds.
News, Sports and Traffic are not part of EF120. Head, torso and tail describe
broad common-to-less-common entity groupings; the shipped data does not fully
specify a reproducible tier-selection procedure. The FCD taxonomy and feed
selection are not independently validated strata. Four paywalled feeds were
excluded when the dataset was assembled. Dataset inclusion does not establish
current access or permission.

The benchmark is fixed, can be tuned to, and need not generalize to other
queries, sources or times. Feeds can overlap. Report selections, holds,
coverage, collection times, policies and the scorer hashes. A subset remains
exploratory even if it has enough cells for a numerical combined score.

## Evidence Freshness

EF asks whether returned evidence supports the requested entity, field and
source-grounded timestamp, then scores the age of supported evidence at the
request time. It does not make an independent current-truth fetch or score
answer correctness. Source publication/update lag is included.

| Category | Full-credit window | Half-life afterward |
| -------- | -----------------: | ------------------: |
| Weather  |         30 minutes |          60 minutes |
| Finance  |          5 minutes |          15 minutes |

```text
ageMinutes = (requestTime - supportedSourceTime) / 60,000
evidenceScore = 100 * 2 ^ (-max(0, ageMinutes - fullCreditMinutes) / halfLifeMinutes)
```

Full credit includes the window boundary. The scorer chooses supported evidence
under its recorded policy. Missing, unsupported, future or wrong-type clocks
are zero-credit evidence; a held task is unscored. Judge refusal, malformed
output, transport failure or exhausted budget is not invented as a
missing-as-zero judgment.

The confirmed-clock evaluator examines the complete bounded provider response,
including evidence beyond the requested rank when actually returned. The
limits are 1 MiB per response, 100 returned results, 60,000 characters per
source and 200,000 source characters in total; exceeding a limit fails the
response rather than silently truncating it. Requests to built-in search
adapters have their own limits, commonly ten results and 7,000 characters.
The judge processes extraction and confirmation with possible repair attempts
per source, so no fixed four-call-per-task maximum is implied. Its output is
validated against the source rather than treating an unsupported generated
timestamp as proof.

For an evaluation, EF is the arithmetic mean of the available
category/tier **cell means**, not the mean of all tasks when cells are
unbalanced. Each cell reports its assigned and scored count. A single-panel
synthetic fixture summary is instead an arithmetic mean of its scored rows.
Held or unknown EF assignments are not converted to zero.

Node 22, 24 and 26 are supported, including patch updates. Weather validation
records the actual Node, ICU and timezone-data identity in each task binding.
Replay requires that recorded runtime, and timezone/DST conformance is checked
before collection. Review compatibility or rebaseline rather than pooling
scores across changed timezone semantics. The judge transport is also bound:
Azure Responses does not support seeded requests, unlike the seeded Chat
Completions request, so the two are not claimed to have seeded parity.

## Fresh Content Discovery

Each eligible feed contributes ten newest eligible targets; there is no
maximum target age. Matching a target URL or accepted alias is a hit.
Content-length diagnostics are separate from the hit definition.

| Age at the original reference time | Possible points |
| ---------------------------------- | --------------: |
| Under 30 minutes                   |              15 |
| 30 minutes to under 1 hour         |              10 |
| 1 hour to under 6 hours            |               5 |
| 6 hours to under 24 hours          |               2 |
| 24 hours or older                  |               1 |

Upper boundaries are exclusive. All provider lanes for a feed use the same
original reference, target identities and reference-time age weights. A target
published after that reference is excluded. The reliability score is:

```text
FCD = 100 * sum(earned hit points) / sum(possible points for eligible targets)
```

An eligible target whose provider result is unavailable earns zero but remains
in the possible-points denominator; a successful empty response is also a miss.
Held feeds and targets excluded by the reference-age rule are not eligible.
No eligible denominator means `null`, not zero. Coverage separately reports
scored targets over assigned target opportunities.

Reference collection applies just-in-time robots and page-policy checks,
access-proof binding and deadlines. Each feed/provider qualification is capped
at 24 publisher requests, including redirects. These checks do not grant a
license.
The collector checks the FreshSearchBenchmark crawler token and generic
directives, not unrelated provider crawler tokens. Individual providers can
have different access permissions. There is no publisher-hold requirement in
the scoring contract; access qualification is not a content license.
The reference and provider evidence remain in memory during the evaluation;
live receipts retain identifiers and derived metadata, not content for replay.
FCD hit rates do not distinguish prior indexing from on-demand retrieval.

## Combined score

When eligible, the per-provider score is:

```text
Combined = 0.20 * EF + 0.80 * FCD
```

The launcher requires a complete selected execution, all selected EF
assignments scored across all six Weather/Finance tier cells, at least one
eligible FCD target, matching original reference identities across provider
lanes, and the expected policy and cohort bindings. Missing panels,
incomplete EF cells and an empty FCD denominator yield an incomplete combined
result, not a fabricated zero. Eligible FCD unavailability remains in its
denominator as described above.

This eligibility check does not claim that a subset is the complete launch
dataset. Comparisons also require matched task/feed selections, compatible
policies, time windows, adapters, content budgets and authorized collection.
Separate evaluation receipts use per-run keyed fingerprints and should not be
assumed comparable merely because they both have a score.

## Limits

No confidence intervals are calculated. Search timings measure adapter
invocation including checkpoint overhead, not isolated network latency.
Provider and judge behavior can vary, and model settings do not guarantee
determinism. Separate accounts and custom adapters may have different access,
retention, pacing and logging terms.
