import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCustomProvider,
  fetchProviderModels,
  getCustomProvider,
  listCustomProviderModels,
  loadCustomProviders,
  migrateLegacyCustomProvider,
  patchCustomProvider,
  resolveCustomModelConfig,
  resolveCustomProviderConfig,
  upsertCustomProvider,
} from '@/ai-v2/customProviders';

/** 与真实 Android 桥一致的安全存储模拟 */
function installBridge() {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'AndroidBridge', {
    value: {
      secureGet: (key: string) => store.get(key) ?? null,
      secureSet: (key: string, value: string) => { store.set(key, value); return true; },
      secureRemove: (key: string) => { store.delete(key); },
    },
    configurable: true,
    writable: true,
  });
  return store;
}

function modelsResponse(ids: string[]) {
  return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('自定义 OpenAI 兼容接口（多条目）', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    Object.defineProperty(window, 'AndroidBridge', { value: undefined, configurable: true, writable: true });
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('可以添加任意多个接口并各自保存地址与 Key', () => {
    installBridge();
    const a = upsertCustomProvider({ name: '本地 Ollama', endpoint: 'http://127.0.0.1:11434/v1' });
    const b = upsertCustomProvider({ name: '公司网关', endpoint: 'https://gw.example.com/v1/', apiKey: 'sk-gw' });

    const list = loadCustomProviders();
    expect(list).toHaveLength(2);
    // 末尾斜杠会被规整掉
    expect(list.find(item => item.id === b.id)?.endpoint).toBe('https://gw.example.com/v1');
    expect(getCustomProvider(a.id)?.apiKey).toBeUndefined();
    expect(getCustomProvider(b.id)?.apiKey).toBe('sk-gw');
  });

  it('按 id 更新只改目标条目', () => {
    installBridge();
    const a = upsertCustomProvider({ name: 'A', endpoint: 'https://a.example/v1', apiKey: 'sk-a' });
    const b = upsertCustomProvider({ name: 'B', endpoint: 'https://b.example/v1' });

    upsertCustomProvider({ id: a.id, endpoint: 'https://a2.example/v1' });
    const list = loadCustomProviders();
    expect(list.find(item => item.id === a.id)?.endpoint).toBe('https://a2.example/v1');
    // 未显式传入的字段保持原值
    expect(list.find(item => item.id === a.id)?.apiKey).toBe('sk-a');
    expect(list.find(item => item.id === b.id)?.endpoint).toBe('https://b.example/v1');
  });

  it('保存后自动拉取模型并写回该条目', async () => {
    installBridge();
    const created = upsertCustomProvider({ endpoint: 'https://auto.example/v1', apiKey: 'sk-auto' });
    const fetch = vi.fn(async () => modelsResponse(['gpt-4o-mini', 'gpt-4.1', 'gpt-4o-mini']));
    vi.stubGlobal('fetch', fetch);

    const updated = await fetchProviderModels(created.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://auto.example/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-auto');
    // 去重后落库
    expect(updated.models).toEqual(['gpt-4o-mini', 'gpt-4.1']);
    expect(getCustomProvider(created.id)?.models).toEqual(['gpt-4o-mini', 'gpt-4.1']);
    expect(getCustomProvider(created.id)?.modelsFetchedAt).toBeTruthy();
  });

  it('拉取失败时抛出可读错误且不改动已有模型列表', async () => {
    installBridge();
    const created = upsertCustomProvider({ endpoint: 'https://fail.example/v1', apiKey: 'bad' });
    patchCustomProvider(created.id, {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    await expect(fetchProviderModels(created.id)).rejects.toThrow(/API Key/);
    expect(getCustomProvider(created.id)?.models).toEqual([]);
  });

  it('请求前把 customProviderId 解析成真实地址、Key 和模型', () => {
    installBridge();
    const provider = upsertCustomProvider({
      endpoint: 'https://resolve.example/v1', apiKey: 'sk-resolve', models: ['my-model'],
    });
    const resolved = resolveCustomProviderConfig({
      type: 'custom', customProviderId: provider.id, model: '',
    });
    expect(resolved.endpoint).toBe('https://resolve.example/v1');
    expect(resolved.api_key).toBe('sk-resolve');
    expect(resolved.model).toBe('my-model');
  });

  it('会话未指定条目时按模型 ID 反查所属接口', () => {
    installBridge();
    upsertCustomProvider({ name: 'A', endpoint: 'https://a.example/v1', apiKey: 'sk-a', models: ['model-a'] });
    const b = upsertCustomProvider({ name: 'B', endpoint: 'https://b.example/v1', apiKey: 'sk-b', models: ['model-b'] });

    const resolved = resolveCustomModelConfig(
      { type: 'custom', customProviderId: 'cp_not_exist', model: 'model-b' },
      'model-b',
    );
    expect(resolved.customProviderId).toBe(b.id);
    expect(resolved.endpoint).toBe('https://b.example/v1');
    expect(resolved.api_key).toBe('sk-b');
  });

  it('聚合所有接口的模型用于选择器展示，重复模型只出现一次', () => {
    installBridge();
    upsertCustomProvider({ endpoint: 'https://a.example/v1', models: ['shared', 'only-a'] });
    upsertCustomProvider({ endpoint: 'https://b.example/v1', models: ['shared', 'only-b'] });

    expect(listCustomProviderModels().map(item => item.value)).toEqual(['shared', 'only-a', 'only-b']);
  });

  it('删除接口后从列表和存储中消失', () => {
    installBridge();
    const a = upsertCustomProvider({ endpoint: 'https://a.example/v1' });
    const b = upsertCustomProvider({ endpoint: 'https://b.example/v1' });
    const next = deleteCustomProvider(a.id);
    expect(next.map(item => item.id)).toEqual([b.id]);
    expect(getCustomProvider(a.id)).toBeUndefined();
  });

  it('旧版单接口配置迁移成一条条目并建立绑定', () => {
    installBridge();
    const migrated = migrateLegacyCustomProvider({
      type: 'custom',
      endpoint: 'https://legacy.example/v1',
      api_key: 'sk-legacy',
      model: 'legacy-model',
    });
    expect(migrated.customProviderId).toBeTruthy();
    const provider = getCustomProvider(migrated.customProviderId);
    expect(provider?.endpoint).toBe('https://legacy.example/v1');
    expect(provider?.apiKey).toBe('sk-legacy');
    expect(provider?.models).toEqual(['legacy-model']);
  });
});
