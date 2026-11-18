# Contributing to FreshSearch

This project welcomes contributions and suggestions. Most contributions require you to
agree to a Contributor License Agreement (CLA) declaring that you have the right to,
and actually do, grant us the rights to use your contribution. For details, visit
[https://cla.opensource.microsoft.com](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need
to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply
follow the instructions provided by the bot. You will only need to do this once across
all repositories using our CLA.

This project follows the [Microsoft Open Source Code of Conduct](CODE_OF_CONDUCT.md).
For usage questions and ordinary bugs, see [support](SUPPORT.md). Report security
vulnerabilities privately using [SECURITY.md](SECURITY.md), not public issues.

## Development

This repository owns the standalone public benchmark: its CLI, scorer, methodology, approved
public datasets, examples, and offline tests. Scoring changes must be explicit,
versioned, and covered by offline regression tests. Provider-specific payload
normalization belongs in the provider adapters rather than the neutral scorer.
Use readable contract identifiers and preserve distinct compatibility formats.

The full offline suite runs on Node.js 22, 24 and 26, including supported patch
updates. Weather contracts record the runtime and timezone-data identity.
From the repository root:

```bash
cd benchmark
npm ci --ignore-scripts
npm test
```

These tests use synthetic or mocked inputs. Do not make live provider, publisher,
or judge calls without explicit authorization, configured credentials, and
reviewed budgets. Never commit credentials, local judge configuration, restricted
publisher content, or live captures.

Keep changes focused and follow the surrounding style. Add regression tests for
behavior changes and update relevant documentation. Preserve original scoring
semantics, third-party notices, and frozen datasets.

Describe the change, relevant issue, and local checks in your pull request.
Use sanitized reproductions; do not attach keys or restricted evidence.

Keep handwritten changes separate from regenerated artifacts when practical.
The scorer and provider-normalization bundles include logical `Module:`
boundaries for review. Review executable changes, contract tests, build hashes
and third-party notices together; do not infer correctness from generated size.
