// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const escapeText = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function axes({ width, height, left, top, right, bottom, xTicks, yTicks, xLabel, yLabel }) {
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const horizontal = yTicks.map((tick, index) => {
    const y = top + plotHeight - index * plotHeight / (yTicks.length - 1);
    return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="grid"/>
<text x="${left - 12}" y="${y + 5}" text-anchor="end" class="axis">${tick}</text>`;
  }).join('');
  const vertical = xTicks.map(([label, fraction]) => {
    const x = left + fraction * plotWidth;
    return `<line x1="${x}" y1="${top}" x2="${x}" y2="${height - bottom}" class="grid"/>
<text x="${x}" y="${height - bottom + 25}" text-anchor="middle" class="axis">${label}</text>`;
  }).join('');
  return `${horizontal}${vertical}
<path d="M${left},${top}V${height - bottom}H${width - right}" class="frame"/>
${xLabel ? `<text x="${left + plotWidth / 2}" y="${height - 12}" text-anchor="middle" class="axis">${escapeText(xLabel)}</text>` : ''}
${yLabel ? `<text transform="translate(20 ${top + plotHeight / 2}) rotate(-90)" text-anchor="middle" class="axis">${escapeText(yLabel)}</text>` : ''}`;
}

function plot(panel, observations = []) {
  const fcd = panel === 'fcd';
  const width = 590;
  const height = 204;
  const config = {
    width, height, left: 50, top: 14, right: 22, bottom: 36,
    xTicks: fcd ? [['0.1', 0], ['0.3', .24], ['1', .5], ['3', .74], ['10', 1]] :
        [['0', 0], ['1', 1 / 3], ['2', 2 / 3], ['3', 1]],
    yTicks: [0, 50, 100], xLabel: null, yLabel: null,
  };
  const centerX = config.left + (width - config.left - config.right) / 2;
  const centerY = config.top + (height - config.top - config.bottom) / 2;
  const measured = observations.filter(row => row.panel === panel &&
    typeof row.searchSeconds === 'number' && row.searchSeconds > 0 && row.score !== null);
  let points = '';
  if (measured.length) {
    const maximum = Math.max(fcd ? 10 : 3, ...measured.map(row => row.searchSeconds));
    const minimum = fcd ? Math.min(.1, ...measured.map(row => row.searchSeconds)) : 0;
    config.yTicks = [0, 50, 100];
    config.xTicks = Array.from({ length: 4 }, (_, index) => {
      const fraction = index / 3;
      const value = fcd ? Math.exp(Math.log(minimum) + fraction * Math.log(maximum / minimum)) : fraction * maximum;
      return [value.toPrecision(2), fraction];
    });
    points = measured.map(row => {
      const fraction = fcd ? Math.log(row.searchSeconds / minimum) / Math.log(maximum / minimum) : row.searchSeconds / maximum;
      const x = config.left + fraction * (width - config.left - config.right);
      const y = config.top + (1 - row.score / 100) * (height - config.top - config.bottom);
      return `<circle cx="${x}" cy="${y}" r="4" fill="#307cdd"><title>${escapeText(row.providerId)}: ${row.score.toFixed(1)}, ${row.searchSeconds.toPrecision(3)} s mean adapter invocation</title></circle>`;
    }).join('');
  }
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${fcd ? 'Fresh Content Discovery score' : 'Evidence Freshness score'} versus latency${measured.length ? ': mean adapter invocation seconds, not network-only latency' : ': unavailable because latency is not measured'}">
${axes(config)}
${measured.length ? points : `<rect x="${centerX - 123}" y="${centerY - 30}" width="246" height="47" fill="white"/>
<text x="${centerX}" y="${centerY - 4}" text-anchor="middle" class="unavailable">Latency not measured</text>`}
</svg>`;
}

function scoreCell(summary, panel, selectedPanel, coverage = '') {
  if (panel !== selectedPanel) return '<td class="missing">Not evaluated</td>';
  const note = coverage ? `<span class="score-note">${escapeText(coverage)}</span>` : '';
  if (summary.score === null) return `<td class="missing">Unscored${note}</td>`;
  return `<td class="panel-value">${summary.score.toFixed(panel === 'fcd' ? 2 : 1)}${
    panel === 'fcd' ? `<span class="score-note">${summary.earnedPoints}/${summary.possiblePoints} age-weighted points</span>` : ''}${note}</td>`;
}

function retrievalCell(summary, panel) {
  if (panel !== 'fcd') return '<td class="missing">Not evaluated</td>';
  const retrieval = summary.retrieval;
  const hitRate = summary.scored ? `${(100 * retrieval.hits / summary.scored).toFixed(1)}% hit rate` :
    'hit rate unavailable';
  const bands = retrieval.ageBands.filter(band => band.scored).map(band =>
    `<span>${escapeText(band.label)}: ${band.hits}/${band.scored} found, ${band.earnedPoints}/${band.possiblePoints} pt</span>`).join('');
  const missed = retrieval.missedTargets.map(target =>
    `<span>${escapeText(target.id)} (${target.ageMinutes === null ? 'age unavailable' :
      `${target.ageMinutes.toFixed(1)} min`}; ${target.points} pt)</span>`).join('; ');
  return `<td class="retrieval-cell"><p><strong>${retrieval.hits}/${summary.scored} scored targets found</strong> (${hitRate}). Coverage: ${summary.scored}/${summary.assigned} assigned (${(100 * summary.coverage).toFixed(1)}%).</p>
<p>Misses: ${retrieval.misses} · Held targets: ${summary.assigned - summary.scored - summary.unknown - (summary.excludedAgeTargets ?? 0)} · Unavailable/pending: ${summary.unknown}${summary.excludedAgeTargets ? ` · Age-excluded: ${summary.excludedAgeTargets}` : ''}</p>
${bands ? `<p class="age-breakdown"><strong>Target age:</strong>${bands}</p>` : ''}
<p class="missed-targets">Missed target IDs: ${missed || 'none among scored targets'}${
    retrieval.misses > retrieval.missedTargets.length ?
      `; showing ${retrieval.missedTargets.length} of ${retrieval.misses} misses; see cases.csv for all` : ''}.</p></td>`;
}

const style = `
:root{font-family:Arial,Helvetica,sans-serif;color:#111519;background:#fff;font-size:15px;line-height:1.4}
*{box-sizing:border-box}body{margin:0;padding:4px}main{max-width:1800px;margin:auto;border:1px solid #e0e4e9}
h1,h2,p{margin:0}h1,h2{font-size:17px;font-weight:600;letter-spacing:.1px}
.charts{display:grid;grid-template-columns:1fr 1fr}
.chart-heading{display:flex;justify-content:space-between;align-items:baseline;gap:14px}.chart-note{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#6b7078;letter-spacing:.3px;white-space:nowrap}
svg{display:block;width:100%;height:auto}.side-chart{padding:22px 24px 23px;min-width:0}.side-chart+.side-chart{border-left:1px solid #e0e4e9}.side-chart svg{margin-top:18px}
.grid{stroke:#e6eaf0;stroke-width:1.3;stroke-dasharray:3 5}.frame{stroke:#e0e4e9;stroke-width:1.2;fill:none}.axis{fill:#6b7078;font:14px ui-monospace,SFMono-Regular,Consolas,monospace}.unavailable{fill:#626a74;font-size:17px}.unavailable-note{fill:#6b7078;font-size:14px}
.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;table-layout:fixed;text-align:left}col.provider{width:16%}col.outcomes{width:38%}col.fcd{width:16%}col.ef{width:15%}col.combined{width:15%}
th{background:#f4f6f8;color:#6b7078;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;white-space:nowrap}th,td{padding:15px 19px;border-top:1px solid #e0e4e9;vertical-align:middle}td{font-size:16px;overflow-wrap:anywhere}td.rank{color:#747b85;font:16px ui-monospace,SFMono-Regular,Consolas,monospace}.provider-name{font-weight:600}.provider-context{display:block;font-size:11px;color:#6b7078;margin-top:3px}.combined-value{font:600 25px ui-monospace,SFMono-Regular,Consolas,monospace;color:#89909a}.panel-value{font:600 20px ui-monospace,SFMono-Regular,Consolas,monospace;color:#2d78da}.missing{font-size:12px;color:#6b7078}
.legend{display:inline-flex;align-items:center;gap:7px}.legend+.legend{margin-left:15px}.swatch{display:inline-block;width:10px;height:10px;background:#307cdd;border-radius:2px}.swatch.ef{background:#acd3ff}
.retrieval-cell{font-size:12px;line-height:1.6}.retrieval-cell p+p{margin-top:5px}.age-breakdown{display:flex;flex-wrap:wrap;gap:3px 12px}.score-note{display:block;font:11px Arial,Helvetica,sans-serif;color:#656d78;margin-top:5px}.missed-targets{color:#656d78}
.status-banner{background:#fff4e5;border-bottom:2px solid #c25e00;color:#5c2c00;padding:12px 19px;font-size:13px}.status-banner ul{margin:6px 0 0;padding-left:20px}
.caption{font-size:11px;color:#656d78;padding:12px 19px;border-top:1px solid #e0e4e9;line-height:1.6}.fixture-badge{display:inline-block;color:#2467b9;background:#edf5ff;border:1px solid #d5e6fa;border-radius:3px;font-size:10px;font-weight:600;padding:1px 6px;margin-right:8px;white-space:nowrap}
@media(min-width:1450px){h1,h2{font-size:19px}.chart-note{font-size:13px}th,td{padding:18px 23px}.combined{padding-top:30px}.side-chart{padding:25px 28px}.panel-value{font-size:22px}}
@media(max-width:1050px){.chart-heading{align-items:flex-start;flex-direction:column;gap:5px}.combined{padding:22px 16px 30px}.side-chart{padding:20px 16px}th,td{padding:14px 14px}table{min-width:850px}}
@media(max-width:650px){body{padding:0}.charts{grid-template-columns:1fr}.side-chart{padding:20px 18px}.side-chart+.side-chart{border-left:0;border-top:1px solid #e0e4e9}.side-chart svg{margin-top:14px}h1,h2{font-size:17px}.chart-heading{flex-direction:row;align-items:baseline;flex-wrap:wrap}.chart-note{font-size:10px;white-space:normal}.axis{font-size:20px}.unavailable{font-size:22px}.caption{padding:11px 14px}}
`;

export function renderViewer(collection) {
  const runs = collection.runs.filter(run => run.status === 'complete');
  const kinds = [...new Set(runs.map(run => run.report.kind))];
  const synthetic = kinds.length === 1 && kinds[0] === 'synthetic-fixture';
  const scorers = [...new Set(runs.map(run => run.report.provenance.outputSha256).filter(Boolean))];
  const excluded = collection.runs.length - runs.length;
  const observations = runs.flatMap(run => run.report.summary.map(summary => ({ ...summary, panel: run.report.panel })));
  const measured = observations.some(row => typeof row.searchSeconds === 'number' && row.searchSeconds > 0);
  const evaluation = collection.evaluation;
  const coverageText = (providerId, panel) => {
    const row = evaluation?.coverage?.byProvider?.find(item => item.providerId === providerId && item.panel === panel);
    return row ? `Coverage: ${panel.toUpperCase()} ${row.completed}/${row.assigned} ${panel === 'fcd' ? 'feeds' : 'tasks'}` : '';
  };
  const rows = evaluation ? evaluation.providers.map(provider => {
    const fcd = provider.fcd;
    const ef = provider.ef;
    const context = [
      fcd ? `FCD ${fcd.scored}/${fcd.assigned} scored` : 'FCD not evaluated',
      ef ? `EF ${ef.scored}/${ef.assigned} scored` : 'EF not evaluated',
      ...['fcd', 'ef'].map(panel => coverageText(provider.providerId, panel)).filter(Boolean),
    ].join(' · ');
    const combined = provider.combined?.score;
    return `<tr><td><span class="provider-name">${escapeText(provider.providerId)}</span><span class="provider-context">${context}</span></td>
${retrievalCell(fcd, fcd ? 'fcd' : '')}
${scoreCell(fcd, fcd ? 'fcd' : '', 'fcd', coverageText(provider.providerId, 'fcd'))}${scoreCell(ef, ef ? 'ef' : '', 'ef', coverageText(provider.providerId, 'ef'))}${combined === null || combined === undefined ?
    '<td class="missing">Incomplete</td>' : `<td class="combined-value">${combined.toFixed(1)}</td>`}</tr>`;
  }).join('') :
    runs.flatMap(run => run.report.summary.map(summary => {
    const context = `${run.report.panel.toUpperCase()} · ${run.id} · ${run.groupId}${kinds.length > 1 ? ` · ${run.report.kind}` : ''}`;
    return `<tr><td><span class="provider-name">${escapeText(summary.providerId)}</span><span class="provider-context">${escapeText(context)}</span></td>
${retrievalCell(summary, run.report.panel)}
${scoreCell(summary, run.report.panel, 'fcd')}${scoreCell(summary, run.report.panel, 'ef')}</tr>`;
  })).join('');
  const caption = [
    evaluation ? `${evaluation.status === 'complete' ? 'Evaluation complete' : `INCOMPLETE evaluation (${evaluation.status})`}: ${evaluation.completed}/${evaluation.assigned} invocations complete; ${evaluation.failed} failed/interrupted; ${evaluation.skipped ?? 0} skipped; ${evaluation.pending} pending.` :
      synthetic ? 'Not measured provider performance.' : `${kinds.join(' / ') || 'No valid results'}.`,
    evaluation ? 'Combined score: 20% Evidence Freshness and 80% Fresh Content Discovery, only for complete, bound panels in this evaluation. Unfinished assignments remain in the denominators. See summary.json and evaluation.json for exclusions.' :
      `Independent runs, not paired or ranked${scorers.length === 1 ? `; scorer ${scorers[0].slice(0, 12)}` : '; multiple or unknown scorers kept separate'}.`,
    measured ? 'Measured points use mean adapter invocation time (including diagnostics checkpoint I/O), not network-only latency; older captures may lack timing.' :
      'Latency not measured.',
    'How to read: higher panel scores are better; coverage shows how many assignments were scored. Independent runs are not rankings. Group IDs identify compatible configurations, not matched targets.',
    observations.some(row => row.panel === 'fcd') ?
      evaluation ? 'FCD score is the share of age-weighted eligible points, not the hit rate; unavailable eligible targets contribute zero. Coverage is captured/assigned targets. Single-feed pilots are setup checks, not provider comparisons. Missed IDs match cases.csv; article URLs, text and credentials are not embedded.' :
        'FCD score is the share of age-weighted available points, not the hit rate. Coverage is scored/assigned targets; held and unknown targets are not misses. Single-feed pilots are setup checks, not provider comparisons. Missed IDs match cases.csv; article URLs, text and credentials are not embedded.' : '',
    excluded ? `${excluded} input(s) excluded; see CLI diagnostics.` : '',
  ].filter(Boolean).join(' ');
  const incomplete = evaluation && evaluation.status !== 'complete';
  const coverageSummary = (evaluation?.coverage?.byPanel ?? []).map(row =>
    `${row.panel.toUpperCase()} ${row.completed}/${row.assigned} ${row.panel === 'fcd' ? 'feed invocations' : 'tasks'}`).join(' · ');
  const failures = (evaluation?.failures ?? []).map(row => `<li>${escapeText([row.status, row.reason,
    row.panel?.toUpperCase(), row.category, row.providerId, row.feedId ?? row.unitId].filter(Boolean).join(' · '))}${
    row.hint ? `: ${escapeText(row.hint)}` : ''}</li>`).join('');
  const banner = incomplete ? `<section class="status-banner" role="alert"><p><strong>${escapeText(
    evaluation.status === 'partial' ? 'PARTIAL evaluation' : `FAILED evaluation (${evaluation.status})`)}</strong>: ${
    evaluation.completed}/${evaluation.assigned} assignments complete, ${evaluation.failed} failed, ${evaluation.skipped ?? 0} skipped, ${
    evaluation.pending} pending. Scores below cover completed assignments only; combined scores stay incomplete.${
    coverageSummary ? ` Coverage: ${escapeText(coverageSummary)}.` : ''}</p>${failures ? `<ul>${failures}</ul>` : ''}</section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src 'none'">
<meta name="referrer" content="no-referrer"><meta name="freshsearch-report" content="${escapeText(collection.version)}"><title>FreshSearch results</title><style>${style}</style></head>
<body><main aria-label="FreshSearch results">${banner}<div class="charts">
<section class="side-chart" aria-labelledby="fcd-heading"><div class="chart-heading"><h2 id="fcd-heading">Fresh Content Discovery (FCD)</h2><span class="chart-note">retrieval latency, log s</span></div>${plot('fcd', observations)}</section>
<section class="side-chart" aria-labelledby="ef-heading"><div class="chart-heading"><h2 id="ef-heading">Evidence Freshness (EF)</h2><span class="chart-note">call latency, s</span></div>${plot('ef', observations)}</section></div>
<div class="table-scroll"><table aria-label="${evaluation ? 'Provider results for one evaluation' : 'Provider results: independent observations, not rankings'}"><colgroup><col class="provider"><col class="outcomes"><col class="fcd"><col class="ef">${evaluation ? '<col class="combined">' : ''}</colgroup>
<thead><tr><th scope="col">Provider</th><th scope="col">FCD retrieval outcomes</th><th scope="col"><span class="legend"><span class="swatch" aria-hidden="true"></span>Fresh Content Discovery</span></th><th scope="col"><span class="legend"><span class="swatch ef" aria-hidden="true"></span>Evidence Freshness</span></th>${evaluation ? '<th scope="col">Combined 80/20</th>' : ''}</tr></thead>
<tbody>${rows || `<tr><td colspan="${evaluation ? 5 : 4}" class="missing">No valid complete results. See CLI diagnostics.</td></tr>`}</tbody></table></div>
<p class="caption">${synthetic ? '<span class="fixture-badge">SYNTHETIC FIXTURE</span>' : ''}${escapeText(caption)}</p>
</main></body></html>\n`;
}
