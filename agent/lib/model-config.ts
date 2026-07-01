const DEFAULT_AGENT_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_INDEX_MODEL = "openai/gpt-5.5";

function getModelFromEnv(key: string, fallback: string): string {
  const configured = process.env[key]?.trim();
  return configured === undefined || configured.length === 0 ? fallback : configured;
}

export function getOpenWikiAgentModel(): string {
  return getModelFromEnv("OPENWIKI_AGENT_MODEL", DEFAULT_AGENT_MODEL);
}

export function getOpenWikiIndexModel(): string {
  return getModelFromEnv("OPENWIKI_INDEX_MODEL", DEFAULT_INDEX_MODEL);
}
