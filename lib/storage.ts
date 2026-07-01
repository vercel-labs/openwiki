import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { getVercelOidcToken } from "@vercel/oidc";
import { get, put } from "@vercel/blob";
import type { GitHubRepoRef } from "@/lib/github-repo-url";
import { wikiGeneratorVersion } from "@/lib/wiki-generator-version";

const LOCAL_ARTIFACT_URL_PREFIX = "local://openwiki/";

const artifactUnavailableMessage = "OpenWiki artifact is unavailable.";

type BlobAuthOptions = {
  oidcToken?: string;
  storeId?: string;
  token?: string;
};

export class ArtifactUnavailableError extends Error {
  constructor(message = artifactUnavailableMessage, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactUnavailableError";
  }
}

export function isArtifactUnavailableError(error: unknown): error is ArtifactUnavailableError {
  return error instanceof ArtifactUnavailableError;
}

export type Repository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  githubUrl: string;
  currentIndexedRevisionId: string | null;
  ownerAvatarUrl: string | null;
  updatedAt: string;
};

export type RepositoryRefreshTarget = Repository & {
  activeIndexJobId: string | null;
  currentCommitSha: string | null;
  currentGeneratorVersion: string | null;
  currentIndexedAt: string | null;
  isFeatured: boolean;
  lastRefreshAttemptedCommitSha: string | null;
  lastRefreshAttemptedGeneratorVersion: string | null;
  lastRefreshCheckedAt: string | null;
  lastRefreshEnqueuedAt: string | null;
};

export type RepositoryMetadata = {
  description: string | null;
  fullName: string;
  githubUrl: string;
  lastMetadataRefreshedAt: string | null;
  ownerAvatarUrl: string | null;
  stargazersCount: number | null;
};

export type WikiRouteParam = {
  owner: string;
  repo: string;
  slug: string;
};

/** Describes the latest observable step in an OpenWiki repository indexing job. */
export type IndexJobPhase =
  | "created"
  | "fetching-repository"
  | "reading-context"
  | "starting-eve-run"
  | "waiting-for-agent"
  | "outlining-wiki"
  | "generating-pages"
  | "agent-response-received"
  | "validating-output"
  | "publishing"
  | "revalidating"
  | "completed"
  | "failed";

export type IndexJob = {
  errorMessage: string | null;
  eveSessionId: string | null;
  finishedAt: string | null;
  id: string;
  phase: IndexJobPhase | null;
  repositoryId: string;
  startedAt: string;
  status: "pending" | "running" | "completed" | "failed";
  updatedAt: string;
};

export type RepositoryGenerationRateLimitConfig = {
  clientDailyLimit: number;
  clientHourlyLimit: number;
  globalHourlyLimit: number;
  repoCooldownMs: number;
};

export type RepositoryGenerationRateLimitScope =
  | "client_day"
  | "client_hour"
  | "global_hour"
  | "repo_cooldown";

export type RepositoryGenerationRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      limit: number;
      resetAt: string;
      retryAfterSeconds: number;
      scope: RepositoryGenerationRateLimitScope;
    };

export type ChatRateLimitConfig = {
  clientDailyLimit: number;
  clientHourlyLimit: number;
  globalHourlyLimit: number;
};

export type ChatRateLimitScope =
  | "client_day"
  | "client_hour"
  | "global_hour";

export type ChatRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      limit: number;
      resetAt: string;
      retryAfterSeconds: number;
      scope: ChatRateLimitScope;
    };

export type SourceFileInput = {
  path: string;
  language: string;
  size: number;
  hash: string;
};

export type CitationInput = {
  path: string;
  startLine?: number;
  endLine?: number;
};

export type WikiPageInput = {
  slug: string;
  title: string;
  markdown: string;
  citations: CitationInput[];
};

export type WikiPageSummary = {
  id: string;
  slug: string;
  title: string;
};

export type WikiNavigationNode = {
  children: WikiNavigationNode[];
  slug?: string;
  title: string;
};

export type RepositoryWiki = {
  repository: Repository;
  commitSha: string | null;
  generatorVersion: string | null;
  indexedAt: string | null;
  navigation: WikiNavigationNode[];
  pages: WikiPageSummary[];
  currentPage: {
    id: string;
    slug: string;
    title: string;
    markdown: string;
    citations: CitationInput[];
  } | null;
};

type Sql = ReturnType<typeof neon>;
type QueryResult = Awaited<ReturnType<Sql>>;

type RepositoryRow = {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  github_url: string;
  owner_avatar_url: string | null;
  active_index_job_id: string | null;
  current_indexed_revision_id: string | null;
  updated_at: string;
};

type RepositoryRefreshTargetRow = RepositoryRow & {
  current_commit_sha: string | null;
  current_generator_version: string | null;
  current_indexed_at: string | null;
  is_featured: boolean | null;
  last_refresh_attempted_commit_sha: string | null;
  last_refresh_attempted_generator_version: string | null;
  last_refresh_checked_at: string | null;
  last_refresh_enqueued_at: string | null;
};

type RepositoryMetadataRow = {
  description: string | null;
  full_name: string;
  github_url: string;
  last_metadata_refreshed_at: string | null;
  owner_avatar_url: string | null;
  stargazers_count: number | null;
};

type WikiRow = RepositoryRow & {
  content_url: string | null;
  citations_url: string | null;
  commit_sha: string | null;
  generator_version: string | null;
  indexed_at: string | null;
  page_id: string | null;
  page_slug: string | null;
  page_title: string | null;
  source_index_url: string | null;
};

type IndexJobRow = {
  eve_session_id: string | null;
  error_message: string | null;
  finished_at: string | null;
  id: string;
  phase: IndexJobPhase | null;
  repository_id: string;
  started_at: string;
  status: IndexJob["status"];
  updated_at: string | null;
};

type RepositoryGenerationRateLimitRow = {
  client_day_count: number;
  client_day_oldest: string | null;
  client_hour_count: number;
  client_hour_oldest: string | null;
  global_hour_count: number;
  global_hour_oldest: string | null;
  repo_cooldown_count: number;
  repo_cooldown_oldest: string | null;
};

type ChatRateLimitRow = {
  client_day_count: number;
  client_day_oldest: string | null;
  client_hour_count: number;
  client_hour_oldest: string | null;
  global_hour_count: number;
  global_hour_oldest: string | null;
};

let sqlClient: Sql | undefined;
let schemaReady: Promise<void> | undefined;

export async function upsertRepository(ref: GitHubRepoRef): Promise<Repository> {
  const sql = await getSql();
  const now = new Date().toISOString();
  const rows = asRows<RepositoryRow>(await sql`
    insert into repositories (
      id, provider, owner, name, full_name, visibility, github_url, created_at, updated_at
    )
    values (
      ${randomUUID()}, 'github', ${ref.owner}, ${ref.name}, ${ref.fullName}, 'public', ${ref.url}, ${now}, ${now}
    )
    on conflict (provider, owner, name)
    do update set
      full_name = excluded.full_name,
      github_url = excluded.github_url,
      updated_at = excluded.updated_at
    returning id, owner, name, full_name, github_url, owner_avatar_url, current_indexed_revision_id, updated_at
  `);

  return mapRepository(rows[0]);
}

export async function listRepositories(): Promise<Repository[]> {
  const sql = await getSql();
  const rows = asRows<RepositoryRow>(await sql`
    select id, owner, name, full_name, github_url, owner_avatar_url, current_indexed_revision_id, updated_at
    from repositories
    order by updated_at desc, full_name asc
    limit 100
  `);

  return rows.map(mapRepository);
}

export async function getRepositoryByFullName(owner: string, name: string): Promise<Repository | null> {
  const sql = await getSql();
  const rows = asRows<RepositoryRow>(await sql`
    select id, owner, name, full_name, github_url, owner_avatar_url, current_indexed_revision_id, updated_at
    from repositories
    where provider = 'github' and owner = ${owner} and name = ${name}
    limit 1
  `);

  return rows[0] === undefined ? null : mapRepository(rows[0]);
}

export async function syncFeaturedRepositories(fullNames: string[]): Promise<void> {
  const sql = await getSql();

  await sql`
    update repositories
    set is_featured = false
    where is_featured = true
      and full_name <> all(${fullNames}::text[])
  `;

  if (fullNames.length === 0) return;

  await sql`
    update repositories
    set is_featured = true
    where full_name = any(${fullNames}::text[])
  `;
}

export async function reserveRepositoryGenerationAttempt(input: {
  clientKeyHash: string;
  config: RepositoryGenerationRateLimitConfig;
  repoFullName: string;
}): Promise<RepositoryGenerationRateLimitResult> {
  const sql = await getSql();
  const now = new Date();
  const repoFullName = input.repoFullName.toLowerCase();
  const clientHourWindowMs = 60 * 60 * 1_000;
  const clientDayWindowMs = 24 * clientHourWindowMs;
  const globalHourWindowMs = clientHourWindowMs;
  const retentionMs = Math.max(
    clientDayWindowMs,
    clientHourWindowMs,
    globalHourWindowMs,
    input.config.repoCooldownMs,
  );
  const retentionStart = new Date(now.getTime() - retentionMs).toISOString();
  const clientHourStart = new Date(now.getTime() - clientHourWindowMs).toISOString();
  const clientDayStart = new Date(now.getTime() - clientDayWindowMs).toISOString();
  const globalHourStart = new Date(now.getTime() - globalHourWindowMs).toISOString();
  const repoCooldownStart = new Date(now.getTime() - input.config.repoCooldownMs).toISOString();

  await sql`
    delete from repository_generation_attempts
    where created_at < ${retentionStart}
  `;

  const rows = asRows<RepositoryGenerationRateLimitRow>(await sql`
    select
      (count(*) filter (
        where client_key_hash = ${input.clientKeyHash}
          and created_at >= ${clientHourStart}
      ))::int as client_hour_count,
      min(created_at) filter (
        where client_key_hash = ${input.clientKeyHash}
          and created_at >= ${clientHourStart}
      ) as client_hour_oldest,
      (count(*) filter (
        where client_key_hash = ${input.clientKeyHash}
          and created_at >= ${clientDayStart}
      ))::int as client_day_count,
      min(created_at) filter (
        where client_key_hash = ${input.clientKeyHash}
          and created_at >= ${clientDayStart}
      ) as client_day_oldest,
      (count(*) filter (
        where repo_full_name = ${repoFullName}
          and created_at >= ${repoCooldownStart}
      ))::int as repo_cooldown_count,
      min(created_at) filter (
        where repo_full_name = ${repoFullName}
          and created_at >= ${repoCooldownStart}
      ) as repo_cooldown_oldest,
      (count(*) filter (
        where created_at >= ${globalHourStart}
      ))::int as global_hour_count,
      min(created_at) filter (
        where created_at >= ${globalHourStart}
      ) as global_hour_oldest
    from repository_generation_attempts
  `);
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Could not read repository generation attempts.");
  }

  const denial =
    input.config.repoCooldownMs > 0 &&
      row.repo_cooldown_count >= 1 &&
      row.repo_cooldown_oldest !== null
      ? createRepositoryGenerationRateLimitDenial({
          limit: 1,
          now,
          oldestAttemptAt: row.repo_cooldown_oldest,
          scope: "repo_cooldown",
          windowMs: input.config.repoCooldownMs,
        })
      : input.config.clientHourlyLimit > 0 &&
          row.client_hour_count >= input.config.clientHourlyLimit &&
          row.client_hour_oldest !== null
        ? createRepositoryGenerationRateLimitDenial({
            limit: input.config.clientHourlyLimit,
            now,
            oldestAttemptAt: row.client_hour_oldest,
            scope: "client_hour",
            windowMs: clientHourWindowMs,
          })
        : input.config.clientDailyLimit > 0 &&
            row.client_day_count >= input.config.clientDailyLimit &&
            row.client_day_oldest !== null
          ? createRepositoryGenerationRateLimitDenial({
              limit: input.config.clientDailyLimit,
              now,
              oldestAttemptAt: row.client_day_oldest,
              scope: "client_day",
              windowMs: clientDayWindowMs,
            })
          : input.config.globalHourlyLimit > 0 &&
              row.global_hour_count >= input.config.globalHourlyLimit &&
              row.global_hour_oldest !== null
            ? createRepositoryGenerationRateLimitDenial({
                limit: input.config.globalHourlyLimit,
                now,
                oldestAttemptAt: row.global_hour_oldest,
                scope: "global_hour",
                windowMs: globalHourWindowMs,
              })
            : null;

  if (denial !== null) return denial;

  await sql`
    insert into repository_generation_attempts (
      id, client_key_hash, repo_full_name, created_at
    )
    values (
      ${randomUUID()}, ${input.clientKeyHash}, ${repoFullName}, ${now.toISOString()}
    )
  `;

  return { allowed: true };
}

export async function reserveChatMessageAttempt(input: {
  clientKeyHash: string;
  config: ChatRateLimitConfig;
  repoFullName: string;
}): Promise<ChatRateLimitResult> {
  const sql = await getSql();
  const now = new Date();
  const clientHourWindowMs = 60 * 60 * 1_000;
  const clientDayWindowMs = 24 * clientHourWindowMs;
  const globalHourWindowMs = clientHourWindowMs;
  const retentionMs = Math.max(clientDayWindowMs, clientHourWindowMs, globalHourWindowMs);
  const retentionStart = new Date(now.getTime() - retentionMs).toISOString();
  const clientHourStart = new Date(now.getTime() - clientHourWindowMs).toISOString();
  const clientDayStart = new Date(now.getTime() - clientDayWindowMs).toISOString();
  const globalHourStart = new Date(now.getTime() - globalHourWindowMs).toISOString();

  await sql`
    delete from chat_message_attempts
    where created_at < ${retentionStart}
  `;

  const rows = asRows<ChatRateLimitRow>(await sql`
    select
      (count(*) filter (
        where client_key_hash = ${input.clientKeyHash}
          and created_at >= ${clientHourStart}
      ))::int as client_hour_count,
      min(created_at) filter (
        where client_key_hash = ${input.clientKeyHash}
          and created_at >= ${clientHourStart}
      ) as client_hour_oldest,
      (count(*) filter (
        where client_key_hash = ${input.clientKeyHash}
          and created_at >= ${clientDayStart}
      ))::int as client_day_count,
      min(created_at) filter (
        where client_key_hash = ${input.clientKeyHash}
          and created_at >= ${clientDayStart}
      ) as client_day_oldest,
      (count(*) filter (
        where created_at >= ${globalHourStart}
      ))::int as global_hour_count,
      min(created_at) filter (
        where created_at >= ${globalHourStart}
      ) as global_hour_oldest
    from chat_message_attempts
  `);
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Could not read chat message attempts.");
  }

  if (
    input.config.clientHourlyLimit > 0 &&
    row.client_hour_count >= input.config.clientHourlyLimit &&
    row.client_hour_oldest !== null
  ) {
    return createChatRateLimitDenial({
      limit: input.config.clientHourlyLimit,
      now,
      oldestAttemptAt: row.client_hour_oldest,
      scope: "client_hour",
      windowMs: clientHourWindowMs,
    });
  }

  if (
    input.config.clientDailyLimit > 0 &&
    row.client_day_count >= input.config.clientDailyLimit &&
    row.client_day_oldest !== null
  ) {
    return createChatRateLimitDenial({
      limit: input.config.clientDailyLimit,
      now,
      oldestAttemptAt: row.client_day_oldest,
      scope: "client_day",
      windowMs: clientDayWindowMs,
    });
  }

  if (
    input.config.globalHourlyLimit > 0 &&
    row.global_hour_count >= input.config.globalHourlyLimit &&
    row.global_hour_oldest !== null
  ) {
    return createChatRateLimitDenial({
      limit: input.config.globalHourlyLimit,
      now,
      oldestAttemptAt: row.global_hour_oldest,
      scope: "global_hour",
      windowMs: globalHourWindowMs,
    });
  }

  await sql`
    insert into chat_message_attempts (
      id, client_key_hash, repo_full_name, created_at
    )
    values (
      ${randomUUID()}, ${input.clientKeyHash}, ${input.repoFullName.toLowerCase()}, ${now.toISOString()}
    )
  `;

  return { allowed: true };
}

export async function listRepositoryRefreshTargets(limit: number): Promise<RepositoryRefreshTarget[]> {
  const sql = await getSql();
  const rows = asRows<RepositoryRefreshTargetRow>(await sql`
    select
      r.id,
      r.owner,
      r.name,
      r.full_name,
      r.github_url,
      r.owner_avatar_url,
      r.active_index_job_id,
      r.current_indexed_revision_id,
      r.is_featured,
      r.last_refresh_attempted_commit_sha,
      r.last_refresh_attempted_generator_version,
      r.last_refresh_checked_at,
      r.last_refresh_enqueued_at,
      r.updated_at,
      rr.commit_sha as current_commit_sha,
      rr.generator_version as current_generator_version,
      rr.indexed_at as current_indexed_at
    from repositories r
    left join repo_revisions rr on rr.id = r.current_indexed_revision_id
    where r.provider = 'github'
    order by
      case
        when r.is_featured = true and (
          rr.commit_sha is null or rr.generator_version is distinct from ${wikiGeneratorVersion}
        ) then 0
        when rr.commit_sha is null or rr.generator_version is distinct from ${wikiGeneratorVersion} then 1
        when r.is_featured = true then 2
        else 3
      end,
      r.last_refresh_checked_at asc nulls first,
      rr.indexed_at asc nulls first,
      r.full_name asc
    limit ${limit}
  `);

  return rows.map(mapRepositoryRefreshTarget);
}

export async function listPublishedWikiRouteParams(
  repositories: Array<{ name: string; owner: string }>,
): Promise<WikiRouteParam[]> {
  if (repositories.length === 0) return [];

  const sql = await getSql();
  return asRows<WikiRouteParam>(await sql`
    select r.owner, r.name as repo, wp.slug
    from repositories r
    join unnest(
      ${repositories.map((repo) => repo.owner)}::text[],
      ${repositories.map((repo) => repo.name)}::text[]
    ) as wanted(owner, name)
      on wanted.owner = r.owner and wanted.name = r.name
    join wiki_pages wp on wp.repository_id = r.id
    where r.provider = 'github'
      and wp.current_revision_id is not null
      and wp.slug <> 'overview'
    order by r.full_name asc, wp.created_at asc
  `);
}

export async function recordRepositoryRefreshCheck(input: {
  enqueued: boolean;
  latestCommitSha?: string;
  latestGeneratorVersion?: string;
  repositoryId: string;
}): Promise<void> {
  const sql = await getSql();
  const now = new Date().toISOString();
  await sql`
    update repositories
    set last_refresh_checked_at = ${now},
      last_refresh_enqueued_at = case when ${input.enqueued} then ${now} else last_refresh_enqueued_at end,
      last_refresh_attempted_commit_sha = case
        when ${input.enqueued} then ${input.latestCommitSha ?? null}
        else last_refresh_attempted_commit_sha
      end,
      last_refresh_attempted_generator_version = case
        when ${input.enqueued} then ${input.latestGeneratorVersion ?? null}
        else last_refresh_attempted_generator_version
      end
    where id = ${input.repositoryId}
  `;
}

export async function recordRepositoryMetadata(input: {
  defaultBranch: string;
  description: string | null;
  ownerAvatarUrl: string | null;
  repositoryId: string;
  stargazersCount: number | null;
}): Promise<void> {
  const sql = await getSql();
  const now = new Date().toISOString();
  await sql`
    update repositories
    set default_branch = ${input.defaultBranch},
      description = ${input.description},
      owner_avatar_url = ${input.ownerAvatarUrl},
      stargazers_count = ${input.stargazersCount},
      last_metadata_refreshed_at = ${now}
    where id = ${input.repositoryId}
  `;
}

export async function listRepositoryMetadataByFullName(fullNames: string[]): Promise<RepositoryMetadata[]> {
  if (fullNames.length === 0) return [];

  const sql = await getSql();
  const rows = asRows<RepositoryMetadataRow>(await sql`
    select
      r.full_name,
      r.github_url,
      r.description,
      r.owner_avatar_url,
      r.stargazers_count,
      r.last_metadata_refreshed_at
    from repositories r
    join unnest(${fullNames}::text[]) as wanted(full_name)
      on wanted.full_name = r.full_name
    where r.provider = 'github'
  `);

  return rows.map(mapRepositoryMetadata);
}

export async function createIndexJob(repositoryId: string): Promise<IndexJob> {
  const sql = await getSql();
  const id = randomUUID();
  const now = new Date().toISOString();
  const rows = asRows<IndexJobRow>(await sql`
    insert into index_jobs (id, repository_id, status, phase, started_at, updated_at)
    values (${id}, ${repositoryId}, 'running', 'created', ${now}, ${now})
    returning id, repository_id, eve_session_id, status, phase, started_at, updated_at, finished_at, error_message
  `);

  return mapIndexJob(rows[0]);
}

/** Reserves a single active indexing job slot for a repository. */
export async function reserveIndexJobForRepository(repositoryId: string): Promise<{
  created: boolean;
  job: IndexJob;
}> {
  const sql = await getSql();
  const id = randomUUID();
  const now = new Date().toISOString();
  const rows = asRows<IndexJobRow>(await sql`
    insert into index_jobs (id, repository_id, status, phase, started_at, updated_at)
    values (${id}, ${repositoryId}, 'running', 'created', ${now}, ${now})
    returning id, repository_id, eve_session_id, status, phase, started_at, updated_at, finished_at, error_message
  `);
  const job = mapIndexJob(rows[0]);
  const reservationRows = asRows<{ id: string }>(await sql`
    update repositories
    set active_index_job_id = ${id}
    where id = ${repositoryId} and active_index_job_id is null
    returning id
  `);

  if (reservationRows.length > 0) {
    return { created: true, job };
  }

  await failIndexJob({
    errorMessage: "Another indexing job was already active for this repository.",
    indexJobId: job.id,
  });

  const activeJob = await getActiveIndexJobForRepository(repositoryId);
  if (activeJob !== null) return { created: false, job: activeJob };

  await sql`
    update repositories
    set active_index_job_id = null
    where id = ${repositoryId}
  `;

  return reserveIndexJobForRepository(repositoryId);
}

/** Returns the newest unfinished indexing job for a repository, if one exists. */
export async function getActiveIndexJobForRepository(repositoryId: string): Promise<IndexJob | null> {
  const sql = await getSql();
  const rows = asRows<IndexJobRow>(await sql`
    select ij.id, ij.repository_id, ij.eve_session_id, ij.status, ij.phase, ij.started_at, ij.updated_at, ij.finished_at, ij.error_message
    from index_jobs ij
    left join repositories r on r.id = ij.repository_id
    where ij.repository_id = ${repositoryId}
      and ij.status in ('pending', 'running')
    order by
      case when r.active_index_job_id = ij.id then 0 else 1 end,
      ij.started_at desc
    limit 1
  `);

  return rows[0] === undefined ? null : mapIndexJob(rows[0]);
}

/** Fails unfinished repository jobs that never attached an eve session before the cutoff. */
export async function failStalePreSessionIndexJobsForRepository(input: {
  errorMessage: string;
  repositoryId: string;
  staleBefore: string;
}): Promise<IndexJob[]> {
  const sql = await getSql();
  const now = new Date().toISOString();
  const rows = asRows<IndexJobRow>(await sql`
    with failed as (
      update index_jobs
      set status = 'failed',
        phase = 'failed',
        updated_at = ${now},
        finished_at = ${now},
        error_message = ${input.errorMessage}
      where repository_id = ${input.repositoryId}
        and status in ('pending', 'running')
        and eve_session_id is null
        and started_at < ${input.staleBefore}
      returning id, repository_id, eve_session_id, status, phase, started_at, updated_at, finished_at, error_message
    ),
    cleared as (
      update repositories r
      set active_index_job_id = null
      from failed
      where r.id = ${input.repositoryId} and r.active_index_job_id = failed.id
      returning r.id
    )
    select id, repository_id, eve_session_id, status, phase, started_at, updated_at, finished_at, error_message
    from failed
  `);

  return rows.map(mapIndexJob);
}

export async function getIndexJob(indexJobId: string): Promise<IndexJob | null> {
  const sql = await getSql();
  const rows = asRows<IndexJobRow>(await sql`
    select id, repository_id, eve_session_id, status, phase, started_at, updated_at, finished_at, error_message
    from index_jobs
    where id = ${indexJobId}
    limit 1
  `);

  return rows[0] === undefined ? null : mapIndexJob(rows[0]);
}

export async function attachEveSessionToIndexJob(input: {
  indexJobId: string;
  eveSessionId: string;
}): Promise<void> {
  const sql = await getSql();
  const now = new Date().toISOString();
  await sql`
    update index_jobs
    set eve_session_id = ${input.eveSessionId},
      updated_at = ${now}
    where id = ${input.indexJobId}
  `;
}

/** Updates the latest progress phase for a running index job. */
export async function setIndexJobPhase(input: {
  indexJobId: string;
  phase: IndexJobPhase;
}): Promise<void> {
  const sql = await getSql();
  const now = new Date().toISOString();
  await sql`
    update index_jobs
    set phase = ${input.phase},
      updated_at = ${now}
    where id = ${input.indexJobId}
  `;
}

/** Records that an indexing job is still alive without changing its visible phase. */
export async function touchIndexJob(indexJobId: string): Promise<void> {
  const sql = await getSql();
  const now = new Date().toISOString();
  await sql`
    update index_jobs
    set updated_at = ${now}
    where id = ${indexJobId} and status in ('pending', 'running')
  `;
}

export async function finishIndexJob(input: {
  indexJobId: string;
  eveSessionId?: string | null;
}): Promise<void> {
  const sql = await getSql();
  const now = new Date().toISOString();
  await sql`
    update index_jobs
    set status = 'completed',
      phase = 'completed',
      eve_session_id = coalesce(${input.eveSessionId ?? null}, eve_session_id),
      updated_at = ${now},
      finished_at = ${now},
      error_message = null
    where id = ${input.indexJobId}
  `;
  await clearActiveIndexJob(sql, input.indexJobId);
}

export async function failIndexJob(input: {
  indexJobId: string;
  errorMessage: string;
  eveSessionId?: string | null;
}): Promise<void> {
  const sql = await getSql();
  const now = new Date().toISOString();
  await sql`
    update index_jobs
    set status = 'failed',
      phase = 'failed',
      eve_session_id = coalesce(${input.eveSessionId ?? null}, eve_session_id),
      updated_at = ${now},
      finished_at = ${now},
      error_message = ${input.errorMessage}
    where id = ${input.indexJobId}
  `;
  await clearActiveIndexJob(sql, input.indexJobId);
}
export async function publishRepositoryOverview(input: {
  repositoryId: string;
  indexJobId: string;
  branch: string;
  commitSha: string;
  fileInventory: SourceFileInput[];
  sourceIndex: unknown;
  title: string;
  markdown: string;
  citations: CitationInput[];
}): Promise<{ pageId: string; pageRevisionId: string; repoRevisionId: string }> {
  const revision = await publishWikiRevision({
    branch: input.branch,
    commitSha: input.commitSha,
    fileInventory: input.fileInventory,
    indexJobId: input.indexJobId,
    pages: [
      {
        citations: input.citations,
        markdown: input.markdown,
        slug: "overview",
        title: input.title,
      },
    ],
    repositoryId: input.repositoryId,
    sourceIndex: input.sourceIndex,
  });
  const page = revision.pages[0];
  if (page === undefined) {
    throw new Error("Overview publish did not create a page.");
  }

  return {
    pageId: page.pageId,
    pageRevisionId: page.pageRevisionId,
    repoRevisionId: revision.repoRevisionId,
  };
}

export async function publishWikiRevision(input: {
  repositoryId: string;
  indexJobId: string;
  branch: string;
  commitSha: string;
  fileInventory: SourceFileInput[];
  sourceIndex: unknown;
  pages: WikiPageInput[];
}): Promise<{
  repoRevisionId: string;
  pages: Array<{ pageId: string; pageRevisionId: string; slug: string }>;
}> {
  const sql = await getSql();
  const now = new Date().toISOString();
  const repoRevisionId = randomUUID();
  const publishedPages: Array<{ pageId: string; pageRevisionId: string; slug: string }> = [];

  const fileInventoryArtifact = await writeArtifact({
    byteContent: JSON.stringify(input.fileInventory, null, 2),
    contentType: "application/json",
    createdByJobId: input.indexJobId,
    key: `repos/${input.repositoryId}/revisions/${input.commitSha}/file-inventory.json`,
    kind: "file_inventory",
  });
  const sourceIndexArtifact = await writeArtifact({
    byteContent: JSON.stringify(input.sourceIndex, null, 2),
    contentType: "application/json",
    createdByJobId: input.indexJobId,
    key: `repos/${input.repositoryId}/revisions/${input.commitSha}/source-index.json`,
    kind: "source_index",
  });

  await sql`
    insert into repo_revisions (
      id, repository_id, branch, commit_sha, generator_version,
      source_index_artifact_id, file_inventory_artifact_id, indexed_at
    )
    values (
      ${repoRevisionId}, ${input.repositoryId}, ${input.branch}, ${input.commitSha}, ${wikiGeneratorVersion},
      ${sourceIndexArtifact.id}, ${fileInventoryArtifact.id}, ${now}
    )
  `;

  await replaceSourceFiles({
    files: input.fileInventory,
    repositoryId: input.repositoryId,
    repoRevisionId,
  });

  await sql`
    update wiki_pages
    set current_revision_id = null, updated_at = ${now}
    where repository_id = ${input.repositoryId}
      and not (slug = any(${input.pages.map((page) => page.slug)}::text[]))
  `;

  for (const page of input.pages) {
    const pageId = randomUUID();
    const pageRevisionId = randomUUID();
    const pageRows = asRows<{ id: string }>(await sql`
      insert into wiki_pages (id, repository_id, slug, title, current_revision_id, created_at, updated_at)
      values (${pageId}, ${input.repositoryId}, ${page.slug}, ${page.title}, null, ${now}, ${now})
      on conflict (repository_id, slug)
      do update set title = excluded.title, updated_at = excluded.updated_at
      returning id
    `);
    const currentPageId = pageRows[0]?.id ?? pageId;

    const markdownArtifact = await writeArtifact({
      byteContent: page.markdown,
      contentType: "text/markdown; charset=utf-8",
      createdByJobId: input.indexJobId,
      key: `repos/${input.repositoryId}/wiki/${currentPageId}/revisions/${pageRevisionId}.md`,
      kind: "wiki_markdown",
    });
    const citationsArtifact = await writeArtifact({
      byteContent: JSON.stringify(page.citations, null, 2),
      contentType: "application/json",
      createdByJobId: input.indexJobId,
      key: `repos/${input.repositoryId}/wiki/${currentPageId}/revisions/${pageRevisionId}.citations.json`,
      kind: "citations",
    });

    await sql`
      insert into wiki_page_revisions (
        id, wiki_page_id, repo_revision_id, content_artifact_id, citations_artifact_id,
        generated_by_job_id, status, created_at
      )
      values (
        ${pageRevisionId}, ${currentPageId}, ${repoRevisionId}, ${markdownArtifact.id}, ${citationsArtifact.id},
        ${input.indexJobId}, 'published', ${now}
      )
    `;

    await sql`
      update wiki_pages
      set current_revision_id = ${pageRevisionId}, updated_at = ${now}
      where id = ${currentPageId}
    `;

    publishedPages.push({
      pageId: currentPageId,
      pageRevisionId,
      slug: page.slug,
    });
  }

  await sql`
    update repositories
    set current_indexed_revision_id = ${repoRevisionId}, updated_at = ${now}
    where id = ${input.repositoryId}
  `;

  return { pages: publishedPages, repoRevisionId };
}

export async function getRepositoryWiki(input: {
  owner: string;
  name: string;
  slug?: string;
}): Promise<RepositoryWiki | null> {
  const wiki = await readRepositoryWiki({
    name: input.name,
    owner: input.owner,
    slug: input.slug ?? "overview",
  });
  if (wiki === null || input.slug !== undefined || wiki.currentPage !== null) return wiki;

  const defaultPage = wiki.pages[0];
  if (defaultPage === undefined || defaultPage.slug === "overview") return wiki;

  return await readRepositoryWiki({
    name: input.name,
    owner: input.owner,
    slug: defaultPage.slug,
  });
}

async function readRepositoryWiki(input: {
  owner: string;
  name: string;
  slug: string;
}): Promise<RepositoryWiki | null> {
  const sql = await getSql();
  const rows = asRows<WikiRow>(await sql`
    select
      r.id,
      r.owner,
      r.name,
      r.full_name,
      r.github_url,
      r.owner_avatar_url,
      r.current_indexed_revision_id,
      r.updated_at,
      rr.commit_sha,
      rr.generator_version,
      rr.indexed_at,
      wp.id as page_id,
      wp.slug as page_slug,
      wp.title as page_title,
      source_index.blob_url as source_index_url,
      content.blob_url as content_url,
      citations.blob_url as citations_url
    from repositories r
    left join repo_revisions rr on rr.id = r.current_indexed_revision_id
    left join artifacts source_index on source_index.id = rr.source_index_artifact_id
    left join wiki_pages wp on wp.repository_id = r.id and wp.slug = ${input.slug}
    left join wiki_page_revisions wpr on wpr.id = wp.current_revision_id
    left join artifacts content on content.id = wpr.content_artifact_id
    left join artifacts citations on citations.id = wpr.citations_artifact_id
    where r.provider = 'github' and r.owner = ${input.owner} and r.name = ${input.name}
    limit 1
  `);
  const row = rows[0];
  if (row === undefined) return null;

  const pages = await getWikiPageSummaries(row.id);
  const sourceIndex = row.source_index_url === null ? null : await readJsonUrl<unknown>(row.source_index_url);
  const markdown = row.content_url === null ? null : await readTextUrl(row.content_url);
  const citations = row.citations_url === null ? [] : await readJsonUrl<CitationInput[]>(row.citations_url);

  return {
    repository: mapRepository(row),
    commitSha: row.commit_sha,
    generatorVersion: row.generator_version,
    indexedAt: row.indexed_at,
    navigation: extractWikiNavigation(sourceIndex, pages),
    pages,
    currentPage:
      row.page_id === null || row.page_slug === null || row.page_title === null || markdown === null
        ? null
        : {
            citations,
            id: row.page_id,
            markdown,
            slug: row.page_slug,
            title: row.page_title,
          },
  };
}

async function replaceSourceFiles(input: {
  repositoryId: string;
  repoRevisionId: string;
  files: SourceFileInput[];
}): Promise<void> {
  const sql = await getSql();
  await sql`delete from source_files where repo_revision_id = ${input.repoRevisionId}`;

  for (const files of chunk(input.files, 1_000)) {
    await sql`
      insert into source_files (id, repository_id, repo_revision_id, path, language, size, hash)
      select *
      from unnest(
        ${files.map(() => randomUUID())}::text[],
        ${files.map(() => input.repositoryId)}::text[],
        ${files.map(() => input.repoRevisionId)}::text[],
        ${files.map((file) => file.path)}::text[],
        ${files.map((file) => file.language)}::text[],
        ${files.map((file) => file.size)}::integer[],
        ${files.map((file) => file.hash)}::text[]
      )
    `;
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function writeArtifact(input: {
  kind: string;
  key: string;
  contentType: string;
  byteContent: string;
  createdByJobId: string;
}): Promise<{ id: string; url: string }> {
  const sql = await getSql();
  const id = randomUUID();
  const bytes = Buffer.from(input.byteContent);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactUrl = await writeArtifactBytes({
    bytes,
    contentType: input.contentType,
    key: input.key,
  });
  const now = new Date().toISOString();

  await sql`
    insert into artifacts (
      id, kind, blob_key, blob_url, content_type, sha256, byte_size, created_by_job_id, created_at
    )
    values (
      ${id}, ${input.kind}, ${input.key}, ${artifactUrl}, ${input.contentType},
      ${sha256}, ${bytes.byteLength}, ${input.createdByJobId}, ${now}
    )
  `;

  return { id, url: artifactUrl };
}

async function writeArtifactBytes(input: {
  bytes: Buffer;
  contentType: string;
  key: string;
}): Promise<string> {
  if (shouldUseLocalArtifacts()) {
    const path = getLocalArtifactPath(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes);
    return `${LOCAL_ARTIFACT_URL_PREFIX}${encodeURIComponent(input.key)}`;
  }

  const blob = await put(input.key, input.bytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    ...(await getBlobAuthOptions()),
    contentType: input.contentType,
  });

  return blob.url;
}

async function getWikiPageSummaries(repositoryId: string): Promise<WikiPageSummary[]> {
  const sql = await getSql();
  return asRows<WikiPageSummary>(await sql`
    select id, slug, title
    from wiki_pages
    where repository_id = ${repositoryId} and current_revision_id is not null
    order by created_at asc
  `);
}

function extractWikiNavigation(sourceIndex: unknown, pages: WikiPageSummary[]): WikiNavigationNode[] {
  const pageSlugs = new Set(pages.map((page) => page.slug));
  const navigation = collapseSinglePageNavigationFolders(readNavigationNodes(sourceIndex, pageSlugs));
  if (navigation.length > 0) return navigation;
  return pages.map((page) => ({
    children: [],
    slug: page.slug,
    title: page.title,
  }));
}

function readNavigationNodes(value: unknown, pageSlugs: Set<string>): WikiNavigationNode[] {
  const sourceIndex = value as { outline?: { navigation?: unknown } } | null;
  const navigation = sourceIndex?.outline?.navigation;
  if (!Array.isArray(navigation)) return [];
  return navigation.flatMap((node) => normalizeNavigationNode(node, pageSlugs));
}

function normalizeNavigationNode(value: unknown, pageSlugs: Set<string>): WikiNavigationNode[] {
  if (typeof value !== "object" || value === null) return [];
  const input = value as { children?: unknown; slug?: unknown; title?: unknown };
  if (typeof input.title !== "string" || input.title.trim().length === 0) return [];

  const children = Array.isArray(input.children)
    ? input.children.flatMap((child) => normalizeNavigationNode(child, pageSlugs))
    : [];
  const node: WikiNavigationNode = {
    children,
    title: input.title.trim(),
  };

  if (typeof input.slug === "string" && pageSlugs.has(input.slug)) {
    node.slug = input.slug;
  }

  if (node.slug === undefined && node.children.length === 0) return [];
  return [node];
}

function collapseSinglePageNavigationFolders(nodes: WikiNavigationNode[]): WikiNavigationNode[] {
  return nodes.flatMap((node) => {
    const children = collapseSinglePageNavigationFolders(node.children);
    const normalized: WikiNavigationNode = {
      ...node,
      children,
    };

    if (normalized.slug === undefined && children.length === 1) {
      const [child] = children;
      if (child !== undefined && child.slug !== undefined && child.children.length === 0) {
        return [child];
      }
    }

    return [normalized];
  });
}

async function readTextUrl(url: string): Promise<string> {
  if (url.startsWith(LOCAL_ARTIFACT_URL_PREFIX)) {
    try {
      return await readFile(getLocalArtifactPathFromUrl(url), "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        throw new ArtifactUnavailableError(
          "This wiki revision references local development artifacts that are not available in the current runtime.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  let blob: Awaited<ReturnType<typeof get>>;
  try {
    blob = await get(url, {
      access: "private",
      ...(await getBlobAuthOptions()),
    });
  } catch (error) {
    if (isBlobArtifactUnavailableError(error)) {
      throw new ArtifactUnavailableError(
        "This wiki revision references private Blob artifacts that are not available in the current runtime.",
        { cause: error },
      );
    }
    throw error;
  }
  if (blob === null || blob.statusCode !== 200 || blob.stream === null) {
    if (blob === null || [401, 403, 404].includes(blob.statusCode)) {
      throw new ArtifactUnavailableError(
        "This wiki revision references Blob artifacts that are not available in the current runtime.",
      );
    }
    throw new Error(`Could not read artifact: ${url}`);
  }
  return await new Response(blob.stream).text();
}

async function readJsonUrl<T>(url: string): Promise<T> {
  return JSON.parse(await readTextUrl(url)) as T;
}

function shouldUseLocalArtifacts(): boolean {
  return (
    process.env.VERCEL !== "1" &&
    process.env.OPENWIKI_LOCAL_ARTIFACTS === "1" &&
    !hasBlobWriteCredentials()
  );
}

function hasBlobWriteCredentials(): boolean {
  if ((process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "").length > 0) {
    return true;
  }

  const hasStoreId = (process.env.BLOB_STORE_ID?.trim() ?? "").length > 0;
  const hasStaticOidcToken = (process.env.VERCEL_OIDC_TOKEN?.trim() ?? "").length > 0;

  return hasStoreId && (process.env.VERCEL === "1" || hasStaticOidcToken);
}

async function getBlobAuthOptions(): Promise<BlobAuthOptions> {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (token !== undefined && token.length > 0) {
    return { token };
  }

  const storeId = process.env.BLOB_STORE_ID?.trim();
  if (storeId === undefined || storeId.length === 0) {
    return {};
  }

  const oidcToken = await getBlobOidcToken();
  if (oidcToken.length === 0) {
    return {};
  }

  return { oidcToken, storeId };
}

async function getBlobOidcToken(): Promise<string> {
  try {
    const token = (await getVercelOidcToken()).trim();
    if (token.length > 0) return token;
  } catch {
    // Fall back to env for local runs after `vercel env pull`.
  }

  return process.env.VERCEL_OIDC_TOKEN?.trim() ?? "";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isBlobArtifactUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("vercel blob") &&
    (
      message.includes("credentials") ||
      message.includes("forbidden") ||
      message.includes("not found") ||
      message.includes("oidc") ||
      message.includes("unauthorized")
    )
  );
}

function getLocalArtifactPathFromUrl(url: string): string {
  return getLocalArtifactPath(decodeURIComponent(url.slice(LOCAL_ARTIFACT_URL_PREFIX.length)));
}

function getLocalArtifactPath(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");

  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    parts.includes("..") ||
    parts.includes(".")
  ) {
    throw new Error("Invalid local artifact key.");
  }

  return join(process.cwd(), ".openwiki", "artifacts", normalized);
}

function asRows<T>(result: QueryResult): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

async function getSql(): Promise<Sql> {
  sqlClient ??= neon(getDatabaseUrl());
  schemaReady ??= ensureSchema(sqlClient);
  await schemaReady;
  return sqlClient;
}

async function ensureSchema(sql: Sql): Promise<void> {
  await sql`
    create table if not exists repositories (
      id text primary key,
      provider text not null,
      owner text not null,
      name text not null,
      full_name text not null,
      default_branch text,
      description text,
      owner_avatar_url text,
      stargazers_count integer,
      last_metadata_refreshed_at timestamptz,
      is_featured boolean not null default false,
      visibility text not null,
      github_url text not null,
      active_index_job_id text,
      current_indexed_revision_id text,
      last_refresh_checked_at timestamptz,
      last_refresh_enqueued_at timestamptz,
      last_refresh_attempted_commit_sha text,
      last_refresh_attempted_generator_version text,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (provider, owner, name)
    )
  `;
  await sql`
    alter table repositories
    add column if not exists active_index_job_id text
  `;
  await sql`alter table repositories add column if not exists default_branch text`;
  await sql`alter table repositories add column if not exists description text`;
  await sql`alter table repositories add column if not exists owner_avatar_url text`;
  await sql`alter table repositories add column if not exists stargazers_count integer`;
  await sql`alter table repositories add column if not exists last_metadata_refreshed_at timestamptz`;
  await sql`alter table repositories add column if not exists is_featured boolean not null default false`;
  await sql`alter table repositories add column if not exists last_refresh_checked_at timestamptz`;
  await sql`alter table repositories add column if not exists last_refresh_enqueued_at timestamptz`;
  await sql`alter table repositories add column if not exists last_refresh_attempted_commit_sha text`;
  await sql`alter table repositories add column if not exists last_refresh_attempted_generator_version text`;
  await sql`
    create table if not exists index_jobs (
      id text primary key,
      repository_id text not null references repositories(id),
      eve_session_id text,
      status text not null,
      phase text,
      started_at timestamptz not null,
      updated_at timestamptz not null,
      finished_at timestamptz,
      error_message text
    )
  `;
  await sql`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'index_jobs' and column_name = 'ash_session_id'
      ) and not exists (
        select 1 from information_schema.columns
        where table_name = 'index_jobs' and column_name = 'eve_session_id'
      ) then
        alter table index_jobs rename column ash_session_id to eve_session_id;
      end if;
    end $$;
  `;
  await sql`alter table index_jobs add column if not exists eve_session_id text`;
  await sql`alter table index_jobs add column if not exists phase text`;
  await sql`alter table index_jobs add column if not exists updated_at timestamptz`;
  await sql`
    update index_jobs
    set phase = 'starting-eve-run'
    where phase = 'starting-ash-run'
  `;
  await sql`
    update index_jobs
    set updated_at = coalesce(updated_at, finished_at, started_at)
    where updated_at is null
  `;
  await sql`
    create table if not exists artifacts (
      id text primary key,
      kind text not null,
      blob_key text not null,
      blob_url text not null,
      content_type text not null,
      sha256 text not null,
      byte_size integer not null,
      created_by_job_id text references index_jobs(id),
      created_at timestamptz not null
    )
  `;
  await sql`
    create table if not exists repo_revisions (
      id text primary key,
      repository_id text not null references repositories(id),
      branch text not null,
      commit_sha text not null,
      generator_version text,
      source_index_artifact_id text references artifacts(id),
      file_inventory_artifact_id text references artifacts(id),
      indexed_at timestamptz not null
    )
  `;
  await sql`alter table repo_revisions add column if not exists generator_version text`;
  await sql`
    create table if not exists source_files (
      id text primary key,
      repository_id text not null references repositories(id),
      repo_revision_id text not null references repo_revisions(id),
      path text not null,
      language text not null,
      size integer not null,
      hash text not null
    )
  `;
  await sql`
    create table if not exists source_symbols (
      id text primary key,
      source_file_id text not null references source_files(id),
      name text not null,
      kind text not null,
      start_line integer,
      end_line integer
    )
  `;
  await sql`
    create table if not exists wiki_pages (
      id text primary key,
      repository_id text not null references repositories(id),
      slug text not null,
      title text not null,
      current_revision_id text,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (repository_id, slug)
    )
  `;
  await sql`
    create table if not exists wiki_page_revisions (
      id text primary key,
      wiki_page_id text not null references wiki_pages(id),
      repo_revision_id text not null references repo_revisions(id),
      content_artifact_id text not null references artifacts(id),
      citations_artifact_id text references artifacts(id),
      generated_by_job_id text references index_jobs(id),
      status text not null,
      created_at timestamptz not null
    )
  `;
  await sql`
    create table if not exists citations (
      id text primary key,
      wiki_page_revision_id text not null references wiki_page_revisions(id),
      source_file_id text references source_files(id),
      path text not null,
      start_line integer,
      end_line integer,
      quote_hash text
    )
  `;
  await sql`
    create table if not exists chat_sessions (
      id text primary key,
      repository_id text not null references repositories(id),
      eve_session_id text,
      eve_continuation_token text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `;
  await sql`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'chat_sessions' and column_name = 'ash_session_id'
      ) and not exists (
        select 1 from information_schema.columns
        where table_name = 'chat_sessions' and column_name = 'eve_session_id'
      ) then
        alter table chat_sessions rename column ash_session_id to eve_session_id;
      end if;

      if exists (
        select 1 from information_schema.columns
        where table_name = 'chat_sessions' and column_name = 'ash_continuation_token'
      ) and not exists (
        select 1 from information_schema.columns
        where table_name = 'chat_sessions' and column_name = 'eve_continuation_token'
      ) then
        alter table chat_sessions rename column ash_continuation_token to eve_continuation_token;
      end if;
    end $$;
  `;
  await sql`alter table chat_sessions add column if not exists eve_session_id text`;
  await sql`alter table chat_sessions add column if not exists eve_continuation_token text`;
  await sql`
    create table if not exists repository_generation_attempts (
      id text primary key,
      client_key_hash text not null,
      repo_full_name text not null,
      created_at timestamptz not null
    )
  `;
  await sql`
    create index if not exists repository_generation_attempts_client_created_idx
    on repository_generation_attempts (client_key_hash, created_at desc)
  `;
  await sql`
    create index if not exists repository_generation_attempts_repo_created_idx
    on repository_generation_attempts (repo_full_name, created_at desc)
  `;
  await sql`
    create index if not exists repository_generation_attempts_created_idx
    on repository_generation_attempts (created_at desc)
  `;
  await sql`
    create table if not exists chat_message_attempts (
      id text primary key,
      client_key_hash text not null,
      repo_full_name text not null,
      created_at timestamptz not null
    )
  `;
  await sql`
    create index if not exists chat_message_attempts_client_created_idx
    on chat_message_attempts (client_key_hash, created_at desc)
  `;
  await sql`
    create index if not exists chat_message_attempts_created_idx
    on chat_message_attempts (created_at desc)
  `;
}

async function clearActiveIndexJob(sql: Sql, indexJobId: string): Promise<void> {
  await sql`
    update repositories
    set active_index_job_id = null
    where active_index_job_id = ${indexJobId}
  `;
}

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (url === undefined || url.length === 0) {
    throw new Error("DATABASE_URL is required for OpenWiki storage.");
  }
  return url;
}

function mapRepository(row: RepositoryRow): Repository {
  return {
    currentIndexedRevisionId: row.current_indexed_revision_id,
    fullName: row.full_name,
    githubUrl: row.github_url,
    id: row.id,
    name: row.name,
    owner: row.owner,
    ownerAvatarUrl: row.owner_avatar_url,
    updatedAt: row.updated_at,
  };
}

function mapRepositoryRefreshTarget(row: RepositoryRefreshTargetRow): RepositoryRefreshTarget {
  return {
    ...mapRepository(row),
    activeIndexJobId: row.active_index_job_id,
    currentCommitSha: row.current_commit_sha,
    currentGeneratorVersion: row.current_generator_version,
    currentIndexedAt: row.current_indexed_at,
    isFeatured: row.is_featured === true,
    lastRefreshAttemptedCommitSha: row.last_refresh_attempted_commit_sha,
    lastRefreshAttemptedGeneratorVersion: row.last_refresh_attempted_generator_version,
    lastRefreshCheckedAt: row.last_refresh_checked_at,
    lastRefreshEnqueuedAt: row.last_refresh_enqueued_at,
  };
}

function mapRepositoryMetadata(row: RepositoryMetadataRow): RepositoryMetadata {
  return {
    description: row.description,
    fullName: row.full_name,
    githubUrl: row.github_url,
    lastMetadataRefreshedAt: row.last_metadata_refreshed_at,
    ownerAvatarUrl: row.owner_avatar_url,
    stargazersCount: row.stargazers_count,
  };
}

function mapIndexJob(row: IndexJobRow): IndexJob {
  return {
    errorMessage: row.error_message,
    eveSessionId: row.eve_session_id,
    finishedAt: row.finished_at,
    id: row.id,
    phase: row.phase,
    repositoryId: row.repository_id,
    startedAt: row.started_at,
    status: row.status,
    updatedAt: row.updated_at ?? row.finished_at ?? row.started_at,
  };
}

function createRepositoryGenerationRateLimitDenial(input: {
  limit: number;
  now: Date;
  oldestAttemptAt: string;
  scope: RepositoryGenerationRateLimitScope;
  windowMs: number;
}): RepositoryGenerationRateLimitResult {
  const resetAt = new Date(new Date(input.oldestAttemptAt).getTime() + input.windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((resetAt.getTime() - input.now.getTime()) / 1_000),
  );

  return {
    allowed: false,
    limit: input.limit,
    resetAt: resetAt.toISOString(),
    retryAfterSeconds,
    scope: input.scope,
  };
}

function createChatRateLimitDenial(input: {
  limit: number;
  now: Date;
  oldestAttemptAt: string;
  scope: ChatRateLimitScope;
  windowMs: number;
}): ChatRateLimitResult {
  const resetAt = new Date(new Date(input.oldestAttemptAt).getTime() + input.windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((resetAt.getTime() - input.now.getTime()) / 1_000),
  );

  return {
    allowed: false,
    limit: input.limit,
    resetAt: resetAt.toISOString(),
    retryAfterSeconds,
    scope: input.scope,
  };
}
