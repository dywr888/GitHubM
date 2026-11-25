import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import AiSettingsPage from '@/pages/AiSettingsPage';
import { loadCustomProviders } from '@/ai-v2/customProviders';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { login: 'octocat' }, token: 'github-token' }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/ai-settings/model']}>
      <Routes>
        <Route path="/ai-settings/:section" element={<AiSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // Radix Select 在 jsdom 中缺少 scrollIntoView
  Element.prototype.scrollIntoView ??= vi.fn();
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('adds a custom OpenAI-compatible endpoint and auto-fetches its models', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'my-gpt' }, { id: 'my-gpt-mini' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);

  renderPage();

  // 切换到「自定义接口」
  fireEvent.click(screen.getAllByRole('combobox')[0]);
  fireEvent.click(await screen.findByRole('option', { name: i18n.t('自定义接口') }));

  // 添加入口 → 填写地址与 Key → 保存
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(i18n.t('添加接口')) }));
  fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), {
    target: { value: 'https://mine.example/v1' },
  });
  fireEvent.change(screen.getByPlaceholderText(i18n.t('API Key（免鉴权接口可留空）')), {
    target: { value: 'sk-mine' },
  });
  fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('保存并拉取模型')) }));

  // 自动请求上游 /models，并把模型写进本地条目
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    'https://mine.example/v1/models',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-mine' }) }),
  ));

  await waitFor(() => {
    const [provider] = loadCustomProviders();
    expect(provider.endpoint).toBe('https://mine.example/v1');
    expect(provider.apiKey).toBe('sk-mine');
    expect(provider.models).toEqual(['my-gpt', 'my-gpt-mini']);
  });

  // 拉取到的模型出现在选择列表里（说明已自动填充，无需手点拉取）
  const combos = screen.getAllByRole('combobox');
  fireEvent.click(combos[combos.length - 1]);
  expect(await screen.findByRole('option', { name: 'my-gpt' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'my-gpt-mini' })).toBeTruthy();
});
