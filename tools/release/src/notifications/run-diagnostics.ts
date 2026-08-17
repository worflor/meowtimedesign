type GitHubJobStep = {
  conclusion?: unknown;
  name?: unknown;
};

type GitHubJob = {
  conclusion?: unknown;
  html_url?: unknown;
  name?: unknown;
  steps?: unknown;
};

export type ReleaseRunFailure = {
  job: string;
  step: string;
  url: string;
};

export type ReleaseRunContext = {
  durationMs: number;
  pullRequest: {
    number: number;
    url: string;
  } | null;
};

const FAILED_CONCLUSIONS = new Set([
  "action_required",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function runId(runUrl: string): string | null {
  try {
    const match = new URL(runUrl).pathname.match(/\/actions\/runs\/(\d+)(?:\/|$)/u);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "open-design-release-notifier",
    "x-github-api-version": "2022-11-28",
  };
}

export async function loadReleaseRunContext(input: {
  fetchImpl?: typeof fetch;
  now?: number;
  repository: string;
  runUrl: string;
  token: string;
}): Promise<ReleaseRunContext | null> {
  const id = runId(input.runUrl);
  if (id == null || input.repository.length === 0 || input.token.length === 0) return null;
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.github.com/repos/${input.repository}/actions/runs/${id}`,
    { headers: githubHeaders(input.token) },
  );
  if (!response.ok) throw new Error(`GitHub Actions run HTTP ${response.status}`);
  const payload = await response.json() as {
    created_at?: unknown;
    pull_requests?: unknown;
    run_started_at?: unknown;
  };
  const startedAt = text(payload.run_started_at) || text(payload.created_at);
  const startedAtMs = Date.parse(startedAt);
  const now = input.now ?? Date.now();
  const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : 0;
  const pullRequests = Array.isArray(payload.pull_requests)
    ? payload.pull_requests.flatMap((entry) => {
      if (entry == null || typeof entry !== "object") return [];
      const number = (entry as { number?: unknown }).number;
      return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? [number] : [];
    })
    : [];
  const uniquePullRequests = [...new Set(pullRequests)];
  const pullRequest = uniquePullRequests.length === 1
    ? {
        number: uniquePullRequests[0]!,
        url: `https://github.com/${input.repository}/pull/${uniquePullRequests[0]}`,
      }
    : null;
  return { durationMs, pullRequest };
}

function failedStep(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const steps = value as GitHubJobStep[];
  return text(steps.find((step) => FAILED_CONCLUSIONS.has(text(step.conclusion)))?.name);
}

export async function loadReleaseRunFailures(input: {
  fetchImpl?: typeof fetch;
  repository: string;
  runUrl: string;
  token: string;
}): Promise<ReleaseRunFailure[]> {
  const id = runId(input.runUrl);
  if (id == null || input.repository.length === 0 || input.token.length === 0) return [];
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.github.com/repos/${input.repository}/actions/runs/${id}/jobs?filter=latest&per_page=100`,
    {
      headers: {
        ...githubHeaders(input.token),
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub Actions jobs HTTP ${response.status}`);
  const payload = await response.json() as { jobs?: unknown };
  if (!Array.isArray(payload.jobs)) throw new Error("GitHub Actions jobs response is invalid");
  return (payload.jobs as GitHubJob[])
    .filter((job) => FAILED_CONCLUSIONS.has(text(job.conclusion)))
    .slice(0, 3)
    .map((job) => ({
      job: text(job.name) || "未命名 job",
      step: failedStep(job.steps),
      url: text(job.html_url) || input.runUrl,
    }));
}
