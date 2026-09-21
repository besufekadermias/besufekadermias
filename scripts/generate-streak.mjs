// Generates assets/streak.svg from your real GitHub contribution data.
// Runs inside GitHub Actions (see .github/workflows/streak.yml), so it does
// not depend on any third-party hosted service.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const GRAPHQL_URL = "https://api.github.com/graphql";
const DAY_MS = 86_400_000;

/* ─────────────────────────── GitHub API ─────────────────────────── */

async function graphql(query, variables, token) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "streak-card",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API responded ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GitHub API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const CREATED_AT_QUERY = `
  query ($login: String!) {
    user(login: $login) { createdAt }
  }`;

const YEAR_QUERY = `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`;

/** One entry per calendar day since the account was created. */
export async function fetchDays(login, token) {
  const { user } = await graphql(CREATED_AT_QUERY, { login }, token);
  if (!user) throw new Error(`GitHub user "${login}" was not found`);

  const now = new Date();
  const firstYear = new Date(user.createdAt).getUTCFullYear();
  const lastYear = now.getUTCFullYear();
  const byDate = new Map();

  // The API allows at most a one-year window per request.
  for (let year = firstYear; year <= lastYear; year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to = year === lastYear ? now.toISOString() : `${year}-12-31T23:59:59Z`;
    const data = await graphql(YEAR_QUERY, { login, from, to }, token);
    const weeks = data.user.contributionsCollection.contributionCalendar.weeks;

    for (const week of weeks) {
      for (const { date, contributionCount } of week.contributionDays) {
        byDate.set(date, Math.max(contributionCount, byDate.get(date) ?? 0));
      }
    }
  }

  return [...byDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ─────────────────────────── Streak maths ─────────────────────────── */

const toTime = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (time) => new Date(time).toISOString().slice(0, 10);
const EMPTY_RUN = { length: 0, start: null, end: null };

function findLongestStreak(days) {
  let longest = EMPTY_RUN;
  let run = null;

  for (const { date, count } of days) {
    if (count === 0) {
      run = null;
      continue;
    }
    const continues = run && toTime(date) - toTime(run.end) === DAY_MS;
    run = continues
      ? { ...run, end: date, length: run.length + 1 }
      : { start: date, end: date, length: 1 };
    if (run.length > longest.length) longest = run;
  }
  return longest;
}

function findCurrentStreak(days, todayIso) {
  let i = days.length - 1;

  // Today isn't over yet, so an empty today must not break the streak.
  if (i >= 0 && days[i].date === todayIso && days[i].count === 0) i--;

  let run = EMPTY_RUN;
  while (i >= 0 && days[i].count > 0) {
    if (run.length > 0 && toTime(run.start) - toTime(days[i].date) !== DAY_MS) break;
    run = {
      start: days[i].date,
      end: run.end ?? days[i].date,
      length: run.length + 1,
    };
    i--;
  }

  const yesterdayIso = toIso(toTime(todayIso) - DAY_MS);
  return run.end && run.end >= yesterdayIso ? run : EMPTY_RUN;
}

export function computeStats(days, now = new Date()) {
  const todayIso = toIso(now.getTime());
  return {
    total: days.reduce((sum, d) => sum + d.count, 0),
    since: days.length ? days[0].date : todayIso,
    current: findCurrentStreak(days, todayIso),
    longest: findLongestStreak(days),
  };
}

/* ─────────────────────────── SVG rendering ─────────────────────────── */

const THEME = {
  background: "#0d1117",
  border: "#1f6feb",
  accent: "#58a6ff",
  fire: "#f0883e",
  text: "#c9d1d9",
  muted: "#8b949e",
  number: "#ffffff",
};

const formatDate = (iso, withYear = false) =>
  new Date(toTime(iso)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });

const formatRange = (run) =>
  run.length === 0
    ? "No active streak"
    : run.start === run.end
      ? formatDate(run.end, true)
      : `${formatDate(run.start)} - ${formatDate(run.end)}`;

export function renderSvg({ current, longest }) {
  const t = THEME;
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const gap = 24; // opening at the top of the ring, where the flame sits
  const rotation = -90 + (gap / 2 / circumference) * 360;
  const ringX = 165; // current streak (ring), left half of the card
  const longestX = 335; // longest streak, right half of the card

  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="195" viewBox="0 0 500 195" role="img" aria-label="GitHub streak: ${current.length} day current streak, ${longest.length} day longest streak">
  <style>
    text { font-family: 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif; }
    .value { font-size: 28px; font-weight: 700; fill: ${t.accent}; }
    .label { font-size: 14px; fill: ${t.text}; }
    .sub   { font-size: 12px; fill: ${t.muted}; }
    .ring-number { font-size: 28px; font-weight: 700; fill: ${t.number}; }
    .ring-label  { font-size: 14px; font-weight: 700; fill: ${t.accent}; }
  </style>

  <rect x="0.5" y="0.5" width="499" height="194" rx="4.5" fill="${t.background}" stroke="${t.border}"/>

  <g text-anchor="middle">
    <circle cx="${ringX}" cy="80" r="${radius}" fill="none" stroke="${t.accent}" stroke-width="5"
      stroke-linecap="round" stroke-dasharray="${(circumference - gap).toFixed(2)} ${gap}"
      transform="rotate(${rotation.toFixed(2)} ${ringX} 80)"/>
    <path transform="translate(${ringX - 10} 32) scale(0.85)" fill="${t.fire}"
      d="M12 2C12 2 5 9 5 14.5 5 18.6 8.1 22 12 22s7-3.4 7-7.5c0-3-1.5-5-3-6.5-.3 2-1.2 3-2.5 3.5C14 8 13 4.5 12 2z"/>
    <text x="${ringX}" y="90" class="ring-number">${current.length.toLocaleString("en-US")}</text>
    <text x="${ringX}" y="146" class="ring-label">Current Streak</text>
    <text x="${ringX}" y="168" class="sub">${formatRange(current)}</text>
  </g>

  <g text-anchor="middle">
    <text x="${longestX}" y="90" class="value">${longest.length.toLocaleString("en-US")}</text>
    <text x="${longestX}" y="146" class="label">Longest Streak</text>
    <text x="${longestX}" y="168" class="sub">${formatRange(longest)}</text>
  </g>
</svg>
`;
}

/* ─────────────────────────── Entry point ─────────────────────────── */

async function main() {
  const login = process.env.GH_LOGIN || "besufekadermias";
  const token = process.env.GH_TOKEN;
  const output = process.env.OUTPUT || "assets/streak.svg";

  if (!token) throw new Error("GH_TOKEN is not set");

  const days = await fetchDays(login, token);
  const stats = computeStats(days);

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderSvg(stats), "utf8");

  console.log(
    `${login}: current streak ${stats.current.length}, longest ${stats.longest.length}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}