/*
 * File: models.ts
 * Project: deepsproxy
 * Model catalog with Laizy brand aliases. Clients see and request the
 * `laizy-*` IDs; internally each alias resolves to its DeepSeek model and the
 * existing routing rules (name contains "thinking" / "pro") keep working
 * because resolution happens before routing.
 */

export const MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-thinking',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-thinking',
  'deepseek-v4-pro',
  'deepseek-v4-pro-thinking',
];

/** Client-facing aliases → internal DeepSeek model. */
export const MODEL_ALIASES: Record<string, string> = {
  'laizy-v2-flash': 'deepseek-v4.1-flash',
  'laizy-v2-tink': 'deepseek-v4.1-flash-thinking',
  'laizy-v1-flash': 'deepseek-v4-flash',
  'laizy-v1-flash-thinking': 'deepseek-v4-flash-thinking',
  'laizy-v1-pro': 'deepseek-v4-pro',
  'laizy-v1-pro-thinking': 'deepseek-v4-pro-thinking',
};

/** Pretty names shown in the dashboard and model listings. */
export const DISPLAY_NAMES: Record<string, string> = {
  'laizy-v2-flash': 'Laizy v2 flash',
  'laizy-v2-tink': 'Laizy v2 tink',
  'laizy-v1-flash': 'Laizy v1 flash',
  'laizy-v1-flash-thinking': 'Laizy v1 flash thinking',
  'laizy-v1-pro': 'Laizy v1 pro',
  'laizy-v1-pro-thinking': 'Laizy v1 pro thinking',
};

/** Resolve a client-requested model id to the internal DeepSeek model. */
export function resolveModel(id: string): string {
  return MODEL_ALIASES[id] ?? id;
}

/** Aliases listed on /v1/models and the dashboard (clients use these). */
export function listAliasIds(): string[] {
  return Object.keys(MODEL_ALIASES);
}
