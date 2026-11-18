# Dependency and redistribution review

The committed scorer bundles contain third-party code. Their bundled package
names, versions, and declared licenses are listed in
[`../benchmark/build-manifest.json`](../benchmark/build-manifest.json) and
[`../benchmark/confirmed-clock-build-manifest.json`](../benchmark/confirmed-clock-build-manifest.json).
[`dependency-license-inventory.json`](dependency-license-inventory.json) records
the bundle hash and the declared package list with source license blobs. The
check verifies the bundle hash and consistency with the declared list; it does
not independently identify the packages in the bundle.
[`dependency-license-sources.json`](dependency-license-sources.json) retains the
license texts; [`../NOTICE`](../NOTICE) reproduces them. This is an engineering
inventory and attribution review, not legal advice.

`dom-serializer` 2.0.0 declares MIT, but GitHub classifies its upstream license
as `NOASSERTION`. Its full permission text is reproduced in NOTICE.

The MIT project license applies to Microsoft-authored code; it does not relicense
third-party components, datasets, publisher content, or retained evidence.
Publisher content and provider responses used during live evaluation remain
subject to their owners' terms. The runner does not persist live content, but
collection, judging, derived scores and publication still require authorization.

After a bundle or bundled dependency change, update the manifest and license
sources, then run:

```bash
node tools/dependency-licenses.cjs --write
node tools/dependency-licenses.cjs --check
node tools/apply-license-headers.cjs --check
```

New bundled package versions require their actual license texts and upstream blob
hashes in `dependency-license-sources.json`; the generator rejects missing notices.
