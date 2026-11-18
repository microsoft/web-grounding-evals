// Copyright (c) Microsoft Corporation.
// Microsoft-authored portions are licensed under the MIT license.
// Third-party components retain their licenses; see NOTICE at the repository root.

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// Module: providers.mjs
var providers_exports = {};
__export(providers_exports, {
  mapExaSearchResponse: () => mapExaSearchResponse,
  mapParallelSearchResponse: () => mapParallelSearchResponse,
  mapPerplexitySearchResponse: () => mapPerplexitySearchResponse,
  mapWebIQAutoFullResponse: () => mapWebIQAutoFullResponse,
  mapWebIQClassicResponse: () => mapWebIQClassicResponse
});
module.exports = __toCommonJS(providers_exports);

// Module: services/search/types.js
var SearchProviderName = {
  WEBIQ_WEATHER: "webiq-weather",
  WEBIQ_FINANCE: "webiq-finance",
  WEBIQ_NEWS: "webiq-news",
  WEBIQ_AUTO: "webiq-auto",
  EXA: "exa",
  EXA_AUTO: "exa-auto",
  EXA_LITE: "exa-lite",
  PARALLEL: "parallel",
  PERPLEXITY: "perplexity"
};

// Module: services/fresh-search/timestamp-v6/zones.ts
var FIXED_ZONE_MINUTES = {
  aedt: 11 * 60,
  aest: 10 * 60,
  bst: 60,
  cat: 2 * 60,
  cdt: -5 * 60,
  cest: 2 * 60,
  cet: 60,
  edt: -4 * 60,
  est: -5 * 60,
  gmt: 0,
  ict: 7 * 60,
  ist: 5 * 60 + 30,
  jst: 9 * 60,
  mesz: 2 * 60,
  mez: 60,
  nzdt: 13 * 60,
  nzst: 12 * 60,
  pdt: -7 * 60,
  pst: -8 * 60,
  sast: 2 * 60,
  utc: 0,
  wat: 60,
  z: 0
};
var partsFor = (utcMs, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(utcMs));
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
};
var freshSearchLocalToUtcRange = (year, month, day, hour, minute, second, millisecond, zone) => {
  const localMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (zone.kind === "fixed") {
    const value = localMs - Number(zone.value) * 6e4;
    return { earliestMs: value, latestMs: value };
  }
  let guess = localMs;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = partsFor(guess, String(zone.value));
    const rendered = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    guess = localMs - (rendered - guess);
  }
  const candidates = [];
  for (let deltaMinutes = -120; deltaMinutes <= 120; deltaMinutes += 15) {
    const candidate = guess + deltaMinutes * 6e4;
    const check = partsFor(candidate, String(zone.value));
    if (check.year === year && check.month === month && check.day === day && check.hour === hour && check.minute === minute && check.second === second) {
      candidates.push(candidate);
    }
  }
  if (!candidates.length) throw new Error("invalid_local_time");
  return { earliestMs: Math.min(...candidates), latestMs: Math.max(...candidates) };
};

// Module: services/search/sourceDateClock.ts
var localIso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/u;
var explicitZone = /(?:z|[+-]\d{2}:?\d{2}|\b(?:gmt|utc|[ecmp][sd]t))(?:\s*\([^)]*\))?\s*$/iu;
var sourceDateInstantMs = (value, context) => {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return Date.parse(`${text}T00:00:00Z`);
  if (explicitZone.test(text)) return Date.parse(text);
  const local = localIso.exec(text);
  if (!local || !context?.legacyProducerTimeZone) return void 0;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction] = local;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText
  ].map(Number);
  if (hour > 23 || minute > 59 || second > 59) return void 0;
  const range = freshSearchLocalToUtcRange(year, month, day, hour, minute, second, 0, {
    kind: "iana",
    value: context.legacyProducerTimeZone,
    basis: "explicit_named_zone"
  });
  if (range.earliestMs !== range.latestMs)
    throw new Error("Legacy source-date replay has an ambiguous producer-local timestamp");
  return range.earliestMs + Number((fraction ?? "").padEnd(3, "0").slice(0, 3));
};
var sourceDateReferenceMs = (context) => {
  if (!context) return Date.now();
  if (!explicitZone.test(context.referenceTime) || !Number.isFinite(Date.parse(context.referenceTime)))
    throw new Error("Source-date normalization requires an explicit reference instant");
  if (context.legacyProducerTimeZone)
    new Intl.DateTimeFormat("en-US", { timeZone: context.legacyProducerTimeZone });
  return Date.parse(context.referenceTime);
};

// Module: services/search/sourceDate.ts
var MS_DAY = 864e5;
var MIN_TS = (/* @__PURE__ */ new Date("1995-01-01T00:00:00Z")).getTime();
var plausibleIso = (value, context) => {
  if (!value) return void 0;
  const day = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value)?.[1];
  if (day) {
    const parsedDay = /* @__PURE__ */ new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) {
      return void 0;
    }
  }
  const reference = sourceDateReferenceMs(context);
  const t = sourceDateInstantMs(value, context);
  if (t === void 0 || !Number.isFinite(t) || t < MIN_TS || t > reference + 2 * MS_DAY)
    return void 0;
  return new Date(t).toISOString();
};
var MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12
};
var longDateToIso = (match) => {
  const m = match.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(20\d{2})/);
  if (!m) return void 0;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return void 0;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}T00:00:00Z`;
};
var urlDate = (url, context) => {
  if (!url) return void 0;
  const m = url.match(/\/(20\d{2})[/-]([01]?\d)(?:[/-]([0-3]?\d))?(?:[/-]|$)/);
  if (!m) return void 0;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return void 0;
  return plausibleIso(
    `${m[1]}-${String(month).padStart(2, "0")}-${String(m[3] ?? "01").padStart(2, "0")}T00:00:00Z`,
    context
  );
};
var contentDate = (content, context) => {
  if (!content) return void 0;
  const head = content.slice(0, 4e3);
  const isoDate = /20\d{2}-[01]\d-[0-3]\d(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?/;
  const longDate = /[A-Za-z]+\s+\d{1,2},?\s+20\d{2}/;
  const ctx = head.match(
    new RegExp(
      `(?:published|updated|posted|last\\s+modified)\\b[^0-9A-Za-z]{0,20}(${isoDate.source}|${longDate.source})`,
      "i"
    )
  );
  const candidate = ctx?.[1] ?? head.match(isoDate)?.[0] ?? head.match(
    /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2})\b/i
  )?.[1];
  if (!candidate) return void 0;
  const iso = /^20\d{2}-/.test(candidate) ? candidate.includes("T") ? candidate : `${candidate}T00:00:00Z` : longDateToIso(candidate);
  return plausibleIso(iso, context);
};
var FIELD_PATH_LINE = /(?:^|\n)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])+[ \t]*:/g;
var RECORD_DATE_KEY = /(?:^|\n)[ \t]*(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*\.)?(?:validTime|validDate|observedAt|creationTime|record(?:High|Low)Date)[ \t]*:/i;
var isStructuredContent = (page) => {
  const content = page.content ?? page.snippet ?? "";
  return page.contentKind === "structured-records" || /^\s*[{[]/.test(content) || /(?:^|\n)STRUCTURED FIELD PATHS(?:\r?\n|$)/.test(content) || (content.match(FIELD_PATH_LINE) ?? []).length >= 2 || RECORD_DATE_KEY.test(content);
};
var extractSourceDate = (page, context) => {
  const published = plausibleIso(page.lastUpdatedAt, context) ?? plausibleIso(page.datePublished, context);
  if (published) return published;
  const observed = plausibleIso(page.observedAt, context);
  if (observed) return observed;
  if (isStructuredContent(page)) return void 0;
  return urlDate(page.url, context) ?? contentDate(page.content ?? page.snippet, context);
};
var extractSourceDateWithProvenance = (page, context) => {
  const published = extractSourceDate(page, context);
  if (published) return { date: published, source: "published" };
  const crawled = plausibleIso(page.dateLastCrawled, context) ?? plausibleIso(page.crawledAt, context);
  if (crawled) return { date: crawled, source: "crawled" };
  return {};
};

// Module: services/shared/sourceContent.ts
var prepareCompleteSourceContent = (source) => ({
  ...source,
  contentKind: resolveSourceContentKind(source),
  tokenCount: Math.ceil(source.content.length / 4)
});
var SERIALIZED_RECORD_HEADER = /^[^\r\n]*\bSTRUCTURED DATA\b[^\r\n]*\r?\nSTRUCTURED FIELD PATHS(?:\r?\n|$)/;
var resolveSourceContentKind = (source) => {
  if (source.contentKind === "prose" || source.contentKind === "structured-records") {
    return source.contentKind;
  }
  return SERIALIZED_RECORD_HEADER.test(source.content) ? "structured-records" : "prose";
};

// Module: services/shared/sourceMetadata.ts
var boundedSourceMetadata = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const entries = Object.entries(value).slice(0, 30).flatMap(([key, item]) => {
    if (key.length > 100) return [];
    if (typeof item === "string") return [[key, item.slice(0, 512)]];
    if (typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) {
      return [[key, item]];
    }
    return [];
  });
  return entries.length ? Object.fromEntries(entries) : void 0;
};

// Module: config/webiqFeatures.js
var WEBIQ_AUTO_TEXT_EVIDENCE_POLICY_VERSION = "text-only-not-supported";

// Module: services/shared/structuredJsonRecords.ts
var structuredValueSeparator = (text) => {
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && quoted) index++;
    else if (text[index] === '"') quoted = !quoted;
    else if (text[index] === ":" && !quoted) return index;
  }
  return -1;
};
var structuredPropertyPath = (parent, key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent ? `${parent}.` : ""}${key}` : `${parent}[${JSON.stringify(key)}]`;

// Module: services/scopeTemporalValues.ts
var temporalValueFromRecord = (text) => {
  const separator = structuredValueSeparator(text);
  if (separator < 0) return void 0;
  let value;
  try {
    value = JSON.parse(text.slice(separator + 1));
  } catch {
    return void 0;
  }
  if (typeof value !== "string") return void 0;
  const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!calendarDate.test(value) && !instant.test(value)) return void 0;
  const day = /* @__PURE__ */ new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10))
    return void 0;
  if (calendarDate.test(value)) return { kind: "calendar_date", value };
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return void 0;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  const normalized = time.toISOString();
  return {
    kind: "instant",
    value: fraction ? normalized.replace(/\.\d{3}Z$/, `.${fraction}Z`) : normalized
  };
};

// Module: services/search/structuredFields.ts
var formatStructuredScalar = (value) => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};
var flattenStructuredFields = (value, path, lines) => {
  if (value === void 0) return;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    lines.push(`${path}: ${formatStructuredScalar(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) lines.push(`${path}: []`);
    for (let index = 0; index < value.length; index++) {
      flattenStructuredFields(value[index], `${path}[${index}]`, lines);
    }
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) lines.push(`${path}: {}`);
    for (const [key, child] of entries) {
      flattenStructuredFields(child, structuredPropertyPath(path, key), lines);
    }
  }
};
var structuredFieldLines = (record, rootPath = "context") => {
  const lines = [];
  flattenStructuredFields(record, rootPath, lines);
  return lines;
};

// Module: services/search/webiqFinance.js
var WEBIQ_FINANCE_STRUCTURED_URL = "structured data";
var asRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
var textValue = (record, key) => typeof record?.[key] === "string" && record[key].trim() ? record[key] : void 0;
function instrumentTitle(context) {
  const instrument = asRecord(context?.instrument);
  const displayName = textValue(instrument, "displayName");
  const symbol = textValue(instrument, "symbol");
  return displayName && symbol && !displayName.includes(symbol) ? `${displayName} (${symbol})` : displayName ?? symbol;
}
function coerceAsOfIso(value) {
  let time;
  if (typeof value === "number" && Number.isFinite(value)) time = value >= 1e12 ? value : value * 1e3;
  else if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value.trim()).getTime();
    time = Number.isFinite(parsed) ? parsed : void 0;
  }
  if (time === void 0 || time < Date.parse("1995-01-01T00:00:00Z") || time > Date.now() + 2 * 864e5) return void 0;
  return new Date(time).toISOString();
}
function financeAsOfDate(context) {
  const instrument = asRecord(context?.instrument);
  return instrument ? coerceAsOfIso(instrument.lastTradedAt) ?? coerceAsOfIso(instrument.timeLastTradedUtcInUnixMs) ?? coerceAsOfIso(instrument.currentTimeUtcInUnixMs) : void 0;
}
function serializeFinanceResultContent(page) {
  const { context = {}, title, url, ...additionalContent } = page;
  const metadata = {
    sourceType: "structured-data",
    provider: SearchProviderName.WEBIQ_FINANCE,
    title: title ?? instrumentTitle(context) ?? "WebIQ Finance result",
    originalUrl: url ?? ""
  };
  return [
    "WEBIQ FINANCE STRUCTURED DATA",
    "STRUCTURED FIELD PATHS",
    ...structuredFieldLines(metadata, "source"),
    ...structuredFieldLines(additionalContent, "content"),
    ...structuredFieldLines(context)
  ].join("\n");
}

// Module: services/search/webiqAutoResults.ts
var import_responseRetention = require("../freshsearch-confirmed-clock.cjs");

// Module: services/search/webiqWeather.ts
var asRecord2 = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
var stringField = (record, key) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
};
var isStructuredWeatherCard = (page) => page.currentWeather != null || page.forecastedWeather != null || page.historicalWeather != null || page.location != null || page.alerts != null;
var weatherResultTitle = (page) => {
  if (page.title && page.title.trim()) return page.title;
  if (page.location && page.location.trim()) return `Weather for ${page.location}`;
  return "Weather";
};
var weatherObservedDate = (page) => {
  const current = asRecord2(page.currentWeather);
  const observedAt = stringField(current, "observedAt");
  if (observedAt) {
    const parsed = temporalValueFromRecord(`observedAt: ${JSON.stringify(observedAt)}`);
    if (parsed?.kind === "instant") return parsed.value;
  }
  return void 0;
};
var serializeWeatherResultContent = (page) => {
  const legacyObject = page.groundingContent != null && typeof page.groundingContent === "object";
  if (!isStructuredWeatherCard(page) && !legacyObject) {
    if (page.groundingContent != null) {
      return `WEBIQ WEATHER STRUCTURED DATA (${weatherResultTitle(page)})
${JSON.stringify(
        page.groundingContent,
        null,
        2
      )}`;
    }
    return page.snippet ?? "";
  }
  const { url, title: _title, ...card } = page;
  void _title;
  const metadata = {
    sourceType: "structured-data",
    provider: SearchProviderName.WEBIQ_WEATHER,
    title: weatherResultTitle(page),
    originalUrl: url ?? ""
  };
  return [
    `WEBIQ WEATHER STRUCTURED DATA \u2014 ${weatherResultTitle(page)}`,
    "STRUCTURED FIELD PATHS",
    ...structuredFieldLines(metadata, "source"),
    ...structuredFieldLines(card, "weather")
  ].join("\n");
};

// Module: services/search/webiqAutoResults.ts
var observationDate = (result, url, field, bodyDate) => {
  const dates = [
    bodyDate,
    ...(result.citations ?? []).filter(
      (citation) => citation.url === url && citation.contentSource === (field === "observedAt" ? "weather" : "finance")
    ).map((citation) => citation[field])
  ].flatMap((value) => {
    const parsed = temporalValueFromRecord(`clock: ${JSON.stringify(value)}`);
    return parsed?.kind === "instant" ? [parsed.value] : [];
  });
  return new Set(dates).size === 1 ? dates[0] : void 0;
};
var withCitationClocks = (content, result) => result.citations?.length ? [
  content,
  "STRUCTURED FIELD PATHS",
  ...structuredFieldLines(result.citations, "source.citations")
].join("\n") : content;
var isZeroHitAutoResponse = (data) => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data;
  return !("results" in record) && typeof record.traceId === "string" && record.traceId.trim().length > 0 && !("error" in record) && !("errors" in record);
};
var mapWebIQAutoResponse = (data, _maxResults, _maxLength, textOnly = false, dateNormalization) => {
  const normalization = dateNormalization ?? {
    referenceTime: (0, import_responseRetention.retainedResponseReceivedAt)(data) ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  const results = [];
  (0, import_responseRetention.assertResponseSize)(JSON.stringify(data));
  if (!Array.isArray(data.results) && !isZeroHitAutoResponse(data))
    throw new import_responseRetention.SearchResponseRetentionError("Auto results must be an array");
  const boundedResults = data.results ?? [];
  const retainedRanks = [];
  const excluded = [];
  const excludedResults = textOnly ? boundedResults.filter(
    (result) => result.evidence?.type !== "text" || typeof result.evidence.content !== "string"
  ).length : 0;
  for (const [index, result] of boundedResults.entries()) {
    if (!result || !result.evidence || result.evidence.content === void 0)
      throw new import_responseRetention.SearchResponseRetentionError(`Auto group ${index + 1} has no evidence content`);
    if (textOnly && (result.evidence?.type !== "text" || typeof result.evidence.content !== "string")) {
      excluded.push({ rank: index + 1, reason: "non-text-evidence" });
      continue;
    }
    retainedRanks.push(index + 1);
    const citation = result.citations?.[0];
    const raw = result.evidence?.content;
    const sourceMetadata = boundedSourceMetadata({
      webiqEvidenceType: result.evidence?.type,
      providerReportedCrawledAt: citation?.crawledAt,
      providerReportedUpdatedAt: citation?.lastUpdatedAt,
      providerReportedObservedAt: citation?.observedAt,
      providerReportedLastTradedAt: citation?.lastTradedAt,
      ...textOnly ? {
        webiqEvidencePolicy: WEBIQ_AUTO_TEXT_EVIDENCE_POLICY_VERSION,
        webiqOriginalResultCount: boundedResults.length,
        webiqExcludedResultCount: excludedResults
      } : {}
    });
    if (result.evidence?.type === "text") {
      if (typeof raw !== "string")
        throw new import_responseRetention.SearchResponseRetentionError(`Auto text group ${index + 1} is not prose`);
      const sourceContent2 = prepareCompleteSourceContent({
        content: typeof raw === "string" ? raw : "",
        contentKind: "prose"
      });
      const { date: date2, source: source2 } = extractSourceDateWithProvenance(
        {
          url: citation?.url,
          content: sourceContent2.content,
          lastUpdatedAt: citation?.lastUpdatedAt,
          crawledAt: citation?.crawledAt
        },
        normalization
      );
      results.push({
        url: citation?.url ?? "",
        title: citation?.title ?? "",
        snippet: sourceContent2.content.slice(0, 300),
        ...sourceContent2,
        ...sourceMetadata ? { sourceMetadata } : {},
        ...date2 ? { datePublished: date2, datePublishedSource: source2 } : {}
      });
      continue;
    }
    if (result.evidence?.type === "structured/weather") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new import_responseRetention.SearchResponseRetentionError(`Auto Weather group ${index + 1} is not a record`);
      const page = raw && typeof raw === "object" ? raw : {};
      const structured = isStructuredWeatherCard(page);
      const url = page.url ?? citation?.url ?? "";
      const sourceContent2 = prepareCompleteSourceContent({
        content: withCitationClocks(
          structured ? serializeWeatherResultContent(page) : JSON.stringify(raw, null, 2),
          result
        ),
        contentKind: "structured-records"
      });
      const observedAt2 = page.currentWeather ? observationDate(result, url, "observedAt", weatherObservedDate(page)) : void 0;
      const { date: date2, source: source2 } = extractSourceDateWithProvenance(
        {
          url,
          content: sourceContent2.content,
          contentKind: sourceContent2.contentKind,
          observedAt: observedAt2
        },
        normalization
      );
      results.push({
        url,
        title: citation?.title ?? weatherResultTitle(page),
        snippet: sourceContent2.content.slice(0, 300),
        ...sourceContent2,
        ...sourceMetadata ? { sourceMetadata } : {},
        sourceProvider: SearchProviderName.WEBIQ_WEATHER,
        ...observedAt2 ? { dateObserved: observedAt2 } : {},
        ...date2 ? { datePublished: date2, datePublishedSource: source2 } : {}
      });
      continue;
    }
    const isObject = raw != null && typeof raw === "object";
    const content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    const finance = result.evidence?.type === "structured/finance";
    const context = isObject && !Array.isArray(raw) ? raw : void 0;
    const observedAt = finance && context?.instrument ? observationDate(result, citation?.url ?? "", "lastTradedAt", financeAsOfDate(context)) : void 0;
    const sourceContent = prepareCompleteSourceContent({
      content: isObject ? withCitationClocks(content, result) : content,
      contentKind: isObject ? "structured-records" : "prose"
    });
    const { date, source } = extractSourceDateWithProvenance(
      {
        url: citation?.url,
        content: sourceContent.content,
        contentKind: sourceContent.contentKind,
        lastUpdatedAt: citation?.lastUpdatedAt,
        crawledAt: citation?.crawledAt,
        observedAt
      },
      normalization
    );
    results.push({
      url: citation?.url ?? "",
      title: citation?.title ?? "",
      snippet: sourceContent.content.slice(0, 300),
      ...sourceContent,
      ...sourceMetadata ? { sourceMetadata } : {},
      sourceProvider: finance ? SearchProviderName.WEBIQ_FINANCE : SearchProviderName.WEBIQ_AUTO,
      ...observedAt ? { dateObserved: observedAt } : {},
      ...date ? { datePublished: date, datePublishedSource: source } : {}
    });
  }
  return (0, import_responseRetention.retainResponseMapping)(
    data,
    results.map((result, index) => ({
      result: { ...result, label: `G${retainedRanks[index]}` },
      rank: retainedRanks[index]
    })),
    {
      policy: textOnly ? "text-only" : "all-received",
      receivedCount: boundedResults.length,
      excluded
    }
  );
};

// Module: services/search/webiqClassicResults.ts
var import_responseRetention2 = require("../freshsearch-confirmed-clock.cjs");
var datedFromSignals = (url, content, signals, observedAt) => ({
  url,
  content,
  datePublished: signals?.publishedAt,
  lastUpdatedAt: signals?.lastUpdatedAt,
  crawledAt: signals?.crawledAt,
  observedAt
});
var mapWebIQClassicResponse = (data, _maxResults, _maxLength) => {
  const results = [];
  (0, import_responseRetention2.assertResponseSize)(JSON.stringify(data));
  for (const page of data.webResults ?? []) {
    const sourceContent = prepareCompleteSourceContent(
      { content: page.content ?? page.snippet ?? "", contentKind: "prose" }
    );
    const { date, source } = extractSourceDateWithProvenance(page);
    results.push({
      url: page.url ?? "",
      title: page.title ?? "",
      snippet: page.snippet ?? "",
      ...sourceContent,
      ...page.contentTier ? { contentTier: page.contentTier } : {},
      sourceMetadata: boundedSourceMetadata({
        providerReportedPublishedAt: page.datePublished,
        providerReportedCrawledAt: page.dateLastCrawled ?? page.crawledAt,
        providerReportedUpdatedAt: page.lastUpdatedAt
      }),
      ...date ? { datePublished: date, datePublishedSource: source } : {}
    });
  }
  for (const page of data.weatherResults ?? []) {
    const structured = isStructuredWeatherCard(page) || page.groundingContent != null && typeof page.groundingContent === "object";
    const sourceContent = prepareCompleteSourceContent(
      {
        content: serializeWeatherResultContent(page),
        contentKind: structured ? "structured-records" : "prose"
      }
    );
    const { content } = sourceContent;
    const title = weatherResultTitle(page);
    const observedAt = weatherObservedDate(page);
    const { date, source } = extractSourceDateWithProvenance({
      ...datedFromSignals(page.url, content, page.answerSignals, observedAt),
      contentKind: sourceContent.contentKind
    });
    results.push({
      url: page.url ?? "",
      title,
      snippet: page.snippet ?? content.slice(0, 300),
      ...sourceContent,
      sourceProvider: SearchProviderName.WEBIQ_WEATHER,
      sourceMetadata: boundedSourceMetadata({
        providerReportedPublishedAt: page.answerSignals?.publishedAt,
        providerReportedCrawledAt: page.answerSignals?.crawledAt,
        providerReportedUpdatedAt: page.answerSignals?.lastUpdatedAt
      }),
      ...observedAt ? { dateObserved: observedAt } : {},
      ...date ? { datePublished: date, datePublishedSource: source } : {}
    });
  }
  for (const page of data.financeResults ?? []) {
    const snippet = (page.snippets ?? []).join(" ");
    const sourceContent = prepareCompleteSourceContent(
      { content: serializeFinanceResultContent(page), contentKind: "structured-records" }
    );
    const asOf = financeAsOfDate(page.context);
    const { date, source } = extractSourceDateWithProvenance({
      url: page.url,
      content: sourceContent.content,
      contentKind: sourceContent.contentKind,
      observedAt: asOf
    });
    results.push({
      url: WEBIQ_FINANCE_STRUCTURED_URL,
      title: page.title ?? "WebIQ Finance structured data",
      snippet,
      ...sourceContent,
      sourceProvider: SearchProviderName.WEBIQ_FINANCE,
      ...asOf ? { dateObserved: asOf } : {},
      ...date ? { datePublished: date, datePublishedSource: source } : {}
    });
  }
  for (const page of data.newsResults ?? []) {
    const rawContent = page.content ?? page.groundingContent?.content ?? page.snippet ?? "";
    const sourceContent = prepareCompleteSourceContent(
      { content: rawContent, contentKind: "prose" }
    );
    const { content } = sourceContent;
    const { date, source } = extractSourceDateWithProvenance(
      datedFromSignals(page.url, content, page.answerSignals)
    );
    results.push({
      url: page.url ?? "",
      title: page.title ?? "",
      snippet: page.snippet ?? content.slice(0, 300),
      ...sourceContent,
      sourceProvider: SearchProviderName.WEBIQ_NEWS,
      sourceMetadata: boundedSourceMetadata({
        providerReportedPublishedAt: page.answerSignals?.publishedAt,
        providerReportedCrawledAt: page.answerSignals?.crawledAt,
        providerReportedUpdatedAt: page.answerSignals?.lastUpdatedAt
      }),
      ...date ? { datePublished: date, datePublishedSource: source } : {}
    });
  }
  const known = /* @__PURE__ */ new Set(["webResults", "weatherResults", "financeResults", "newsResults"]);
  for (const [kind, value] of Object.entries(data)) {
    if (!known.has(kind) && kind.endsWith("Results") && Array.isArray(value)) {
      for (const item of value) {
        const content = JSON.stringify(item, null, 2);
        results.push({
          url: "",
          title: kind,
          snippet: content.slice(0, 300),
          ...prepareCompleteSourceContent({ content, contentKind: "structured-records" }),
          sourceMetadata: { webiqEvidenceType: kind }
        });
      }
    }
  }
  return (0, import_responseRetention2.retainAllResponseResults)(data, results.map((result, index) => ({
    ...result,
    label: `G${index + 1}`
  })));
};

// Module: services/search/exa.ts
var import_zod = require("../freshsearch-confirmed-clock.cjs");
var import_responseRetention3 = require("../freshsearch-confirmed-clock.cjs");
var EXA_SEARCH_MODES = {
  [SearchProviderName.EXA]: void 0,
  [SearchProviderName.EXA_AUTO]: "auto",
  [SearchProviderName.EXA_LITE]: "lite"
};
var exaResponseSchema = import_zod.z.object({
  results: import_zod.z.array(
    import_zod.z.object({
      title: import_zod.z.string().nullish(),
      url: import_zod.z.string().nullish(),
      text: import_zod.z.string().nullish(),
      highlights: import_zod.z.array(import_zod.z.string()).nullish(),
      publishedDate: import_zod.z.string().nullish()
    })
  )
});
var mapExaSearchResponse = (data, _maxResults, _maxLength, name) => {
  const parsed = exaResponseSchema.safeParse(data);
  if (!parsed.success) throw new Error(`${name} returned an invalid search response`);
  return (0, import_responseRetention3.retainAllResponseResults)(data, parsed.data.results.map((result, index) => {
    const content = [result.text, ...result.highlights ?? []].filter((value) => typeof value === "string").join("\n\n");
    return {
      label: `C${index + 1}`,
      url: result.url ?? "",
      title: result.title ?? "",
      snippet: result.highlights?.[0] ?? content.slice(0, 300),
      content,
      tokenCount: Math.ceil(content.length / 4),
      sourceProvider: name,
      sourceMetadata: boundedSourceMetadata({
        providerEstimatedPublishedAt: result.publishedDate
      })
    };
  }));
};

// Module: services/search/parallel.ts
var import_responseRetention4 = require("../freshsearch-confirmed-clock.cjs");
var isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var asString = (value) => typeof value === "string" ? value : "";
var parallelErrorMessage = (value) => {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  if (!isRecord(value)) return void 0;
  const message = asString(value.message) || asString(value.detail);
  return message ? message.slice(0, 200) : void 0;
};
var mapParallelSearchResponse = (data, _maxResults, _maxLength) => {
  if (!isRecord(data)) throw new Error("Parallel Search returned an invalid response payload");
  const providerError = parallelErrorMessage(data.error);
  if (providerError || data.type === "error") {
    throw new Error(
      `Parallel Search returned an error${providerError ? `: ${providerError}` : ""}`
    );
  }
  if (!Array.isArray(data.results)) {
    throw new Error("Parallel Search response is missing its results array");
  }
  const usable = data.results.map((value) => {
    if (!isRecord(value) || !Array.isArray(value.excerpts) || value.excerpts.some((excerpt) => typeof excerpt !== "string"))
      throw new Error("Parallel Search returned an unprocessable evidence group");
    const excerpts = value.excerpts;
    const url = asString(value.url);
    const title = asString(value.title);
    const content = excerpts.join("\n\n");
    const datePublished = asString(value.publish_date);
    return { excerpts, url, title, content, datePublished };
  });
  const results = usable.map(({ excerpts, url, title, content, datePublished }, index) => {
    return {
      label: `C${index + 1}`,
      url,
      title,
      snippet: (excerpts[0] ?? "").slice(0, 300),
      content,
      tokenCount: Math.ceil(content.length / 4),
      sourceProvider: SearchProviderName.PARALLEL,
      ...datePublished ? { datePublished, datePublishedSource: "published" } : {}
    };
  });
  if (results.length > 0 && results.every((result) => !result.content.trim())) {
    throw new Error("Parallel Search returned no usable search content");
  }
  return (0, import_responseRetention4.retainAllResponseResults)(data, results);
};

// Module: services/search/perplexity.ts
var import_responseRetention5 = require("../freshsearch-confirmed-clock.cjs");
var asString2 = (value) => typeof value === "string" ? value : "";
var mapPerplexitySearchResponse = (data, _maxResults, _maxLength) => {
  if (!Array.isArray(data.results)) {
    throw new Error("Perplexity Search response is missing its results array");
  }
  const results = data.results.map((result, index) => {
    if (result.snippet != null && typeof result.snippet !== "string")
      throw new Error("Perplexity Search returned no usable search content: invalid snippet");
    const content = asString2(result.snippet);
    const date = asString2(result.date);
    const lastUpdated = asString2(result.last_updated);
    return {
      label: `C${index + 1}`,
      url: asString2(result.url),
      title: asString2(result.title),
      snippet: content.slice(0, 300),
      content,
      tokenCount: Math.ceil(content.length / 4),
      ...date ? { datePublished: date, datePublishedSource: "published" } : {},
      ...lastUpdated ? { sourceMetadata: { providerLastUpdatedAt: lastUpdated } } : {}
    };
  });
  if (results.length > 0 && results.every((result) => !result.content))
    throw new Error("Perplexity Search returned no usable search content");
  return (0, import_responseRetention5.retainAllResponseResults)(data, results);
};

// Module: providers.mjs
function mapWebIQAutoFullResponse(data, maxResults, maxLength, referenceTime) {
  return mapWebIQAutoResponse(data, maxResults, maxLength, false, { referenceTime });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapExaSearchResponse,
  mapParallelSearchResponse,
  mapPerplexitySearchResponse,
  mapWebIQAutoFullResponse,
  mapWebIQClassicResponse
});
