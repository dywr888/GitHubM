// AI V2 — 自定义 OpenAI 兼容接口（多条目）管理
//
// 设计要点：
// - 用户可以添加任意多个「自定义 OpenAI 兼容接口」，每条独立保存 地址 / API Key / 模型列表；
// - 配置整体存入安全存储（Android Keystore，Web 回退 localStorage），API Key 不落明文；
// - 新增或修改地址+Key 后自动调用上游 /models 拉取模型列表，无需手点「拉取模型」；
// - 会话配置里只记录 customProviderId，真正请求前用 resolveCustomProviderConfig()
//   把 id 解析成 endpoint / api_key / model，避免改动已有 provider 请求层。
import type { ModelConfig } from '@/components/ai/aiTypes';
import { getSecureItem, setSecureItem } from '@/lib/secureStorage';
import { normalizeBaseEndpoint } from '@/lib/ai-endpoint';
import { fetchModelsFromAPI } from '@/components/ai/aiProviders';

const STORAGE_KEY = 'ai_custom_providers';

export interface CustomProvider {
  id: string;
  /** 展示名，未填时用地址主机名 */
  name: string;
  /** 基础地址，如 https://api.example.com/v1 */
  endpoint: string;
  apiKey?: string;
  /** 已拉取到的模型 ID 列表 */
  models: string[];
  /** 上次成功拉取模型的时间（ISO） */
  modelsFetchedAt?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  stream?: boolean;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `cp_${Date.now().toString(36)}_${rand}`;
}

/** 从地址推导一个可读名称，作为未命名接口的兜底展示 */
export function providerDisplayName(provider: Pick<CustomProvider, 'name' | 'endpoint'>): string {
  if (provider.name?.trim()) return provider.name.trim();
  try {
    const url = new URL(provider.endpoint);
    return url.host || provider.endpoint;
  } catch {
    return provider.endpoint || '自定义接口';
  }
}

function sanitize(raw: unknown): CustomProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<CustomProvider>;
  const endpoint = normalizeBaseEndpoint(item.endpoint);
  if (!endpoint) return null;
  return {
    id: typeof item.id === 'string' && item.id ? item.id : newId(),
    name: typeof item.name === 'string' ? item.name : '',
    endpoint,
    apiKey: typeof item.apiKey === 'string' && item.apiKey.trim() ? item.apiKey.trim() : undefined,
    models: Array.isArray(item.models)
      ? Array.from(new Set(item.models.filter((m): m is string => typeof m === 'string' && Boolean(m.trim())).map(m => m.trim())))
      : [],
    modelsFetchedAt: typeof item.modelsFetchedAt === 'string' ? item.modelsFetchedAt : undefined,
    supportsTools: typeof item.supportsTools === 'boolean' ? item.supportsTools : undefined,
    supportsVision: typeof item.supportsVision === 'boolean' ? item.supportsVision : undefined,
    stream: typeof item.stream === 'boolean' ? item.stream : undefined,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
  };
}

export function loadCustomProviders(): CustomProvider[] {
  try {
    const raw = getSecureItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitize).filter((item): item is CustomProvider => item !== null);
  } catch {
    return [];
  }
}

export function saveCustomProviders(list: CustomProvider[]): void {
  setSecureItem(STORAGE_KEY, JSON.stringify(list));
}

export function getCustomProvider(id?: string): CustomProvider | undefined {
  if (!id) return undefined;
  return loadCustomProviders().find(item => item.id === id);
}

export function upsertCustomProvider(input: Partial<CustomProvider> & { endpoint: string }): CustomProvider {
  const list = loadCustomProviders();
  const existingIndex = input.id ? list.findIndex(item => item.id === input.id) : -1;
  const base = existingIndex >= 0 ? list[existingIndex] : undefined;
  const normalized: CustomProvider = {
    id: base?.id || input.id || newId(),
    name: (input.name ?? base?.name ?? '').trim(),
    endpoint: normalizeBaseEndpoint(input.endpoint),
    apiKey: (input.apiKey ?? base?.apiKey ?? '').trim() || undefined,
    // 地址或 Key 变化时旧模型列表可能失效，交给调用方决定是否清空
    models: input.models ?? base?.models ?? [],
    modelsFetchedAt: input.modelsFetchedAt ?? base?.modelsFetchedAt,
    supportsTools: input.supportsTools ?? base?.supportsTools,
    supportsVision: input.supportsVision ?? base?.supportsVision,
    stream: input.stream ?? base?.stream,
    createdAt: base?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  const next = existingIndex >= 0
    ? list.map((item, index) => (index === existingIndex ? normalized : item))
    : [...list, normalized];
  saveCustomProviders(next);
  return normalized;
}

export function deleteCustomProvider(id: string): CustomProvider[] {
  const next = loadCustomProviders().filter(item => item.id !== id);
  saveCustomProviders(next);
  return next;
}

/** 用最新拉取结果覆盖模型列表（不改动其他字段） */
export function updateProviderModels(id: string, models: string[]): CustomProvider | undefined {
  const list = loadCustomProviders();
  let updated: CustomProvider | undefined;
  const next = list.map(item => {
    if (item.id !== id) return item;
    updated = {
      ...item,
      models,
      modelsFetchedAt: nowIso(),
      updatedAt: nowIso(),
    };
    return updated;
  });
  if (updated) saveCustomProviders(next);
  return updated;
}

/**
 * 拉取指定接口的模型列表并写回存储。
 * 失败时抛出原始错误信息，调用方负责展示；成功返回更新后的条目。
 */
export async function fetchProviderModels(id: string): Promise<CustomProvider> {
  const provider = getCustomProvider(id);
  if (!provider) throw new Error('接口不存在');
  if (!provider.endpoint) throw new Error('接口地址为空');
  const models = await fetchModelsFromAPI('custom', provider.apiKey ?? '', provider.endpoint);
  const ids = Array.from(new Set(models.map(item => item.id)));
  const updated = updateProviderModels(id, ids);
  if (!updated) throw new Error('接口不存在');
  return updated;
}

/** 更新接口的能力开关（不动模型列表） */
export function patchCustomProvider(id: string, patch: Partial<Pick<CustomProvider, 'supportsTools' | 'supportsVision' | 'stream' | 'name'>>): void {
  const list = loadCustomProviders();
  let changed = false;
  const next = list.map(item => {
    if (item.id !== id) return item;
    changed = true;
    return { ...item, ...patch, updatedAt: nowIso() };
  });
  if (changed) saveCustomProviders(next);
}

/**
 * 会话里只存了 modelType / model，自定义接口需要在多个条目中定位：
 * 优先用配置绑定的条目，模型不在其中时按模型 ID 反查其它条目。
 */
export function resolveCustomModelConfig(config: ModelConfig, model?: string): ModelConfig {
  if (config.type !== 'custom') return config;
  const list = loadCustomProviders();
  if (list.length === 0) return resolveCustomProviderConfig(config);
  const wanted = (model || config.model || '').trim();
  const bound = list.find(item => item.id === config.customProviderId);
  const matched = wanted
    ? list.find(item => item.models.includes(wanted))
    : undefined;
  const provider = (matched && (!bound || bound.id !== matched.id) ? matched : bound) || list[0];
  return {
    ...config,
    customProviderId: provider.id,
    endpoint: provider.endpoint,
    api_key: provider.apiKey,
    model: wanted || provider.models[0] || '',
    supportsTools: config.supportsTools ?? provider.supportsTools,
    supportsVision: config.supportsVision ?? provider.supportsVision,
    stream: config.stream ?? provider.stream,
  };
}

/** 汇总所有自定义接口的模型，供模型选择器展示 */
export function listCustomProviderModels(): Array<{ value: string; label: string; providerId: string }> {
  const seen = new Set<string>();
  const result: Array<{ value: string; label: string; providerId: string }> = [];
  for (const provider of loadCustomProviders()) {
    for (const model of provider.models) {
      if (seen.has(model)) continue;
      seen.add(model);
      result.push({ value: model, label: model, providerId: provider.id });
    }
  }
  return result;
}

/**
 * 旧版本只保存一套自定义接口（endpoint/api_key 直接写在 modelConfig 里）。
 * 读取配置时把它迁移成一条条目并绑定 customProviderId，避免用户重配。
 */
export function migrateLegacyCustomProvider(config: ModelConfig): ModelConfig {
  if (config.type !== 'custom') return config;
  const list = loadCustomProviders();
  if (config.customProviderId && list.some(item => item.id === config.customProviderId)) return config;
  const endpoint = normalizeBaseEndpoint(config.endpoint);
  if (!endpoint) return config;

  const existing = list.find(item => item.endpoint === endpoint);
  if (existing) {
    return { ...config, customProviderId: existing.id, api_key: config.api_key ?? existing.apiKey };
  }
  const created = upsertCustomProvider({
    name: '',
    endpoint,
    apiKey: config.api_key,
    models: config.model?.trim() ? [config.model.trim()] : [],
    supportsTools: config.supportsTools,
    supportsVision: config.supportsVision,
    stream: config.stream,
  });
  return { ...config, customProviderId: created.id };
}

/**
 * 把会话/全局配置里的 customProviderId 解析成可直接发请求的 ModelConfig。
 * 非自定义接口或未绑定接口时原样返回。
 */
export function resolveCustomProviderConfig(config: ModelConfig): ModelConfig {
  if (config.type !== 'custom' || !config.customProviderId) return config;
  const provider = getCustomProvider(config.customProviderId);
  if (!provider) return config;
  const model = config.model?.trim() || provider.models[0] || '';
  return {
    ...config,
    endpoint: provider.endpoint,
    api_key: provider.apiKey,
    model,
    supportsTools: config.supportsTools ?? provider.supportsTools,
    supportsVision: config.supportsVision ?? provider.supportsVision,
    stream: config.stream ?? provider.stream,
  };
}
