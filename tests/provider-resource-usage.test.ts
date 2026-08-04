import { describe, expect, it } from 'vitest';
import {
  parseDeepSeekBalance,
  parseOpenRouterBalance,
  ProviderResourceUsageService,
} from '../src/main/provider-resource-usage';

describe('provider resource usage adapters', () => {
  it('maps DeepSeek official balance without inventing missing currencies', () => {
    expect(
      parseDeepSeekBalance({
        balance_infos: [
          {
            currency: 'CNY',
            granted_balance: '1.00',
            topped_up_balance: '4.50',
            total_balance: '5.50',
          },
        ],
        is_available: true,
      }),
    ).toEqual({ balances: [{ amount: 5.5, currency: 'CNY' }] });
    expect(parseDeepSeekBalance({ balance_infos: [], is_available: false })).toBeUndefined();
  });

  it('maps OpenRouter key usage and derives remaining credit only when the inputs exist', () => {
    expect(parseOpenRouterBalance({ data: { limit: 20, usage: 7.25 } })).toEqual({
      balances: [{ amount: 12.75, currency: 'USD' }],
      limit: 20,
      unlimited: false,
      used: 7.25,
    });
    expect(parseOpenRouterBalance({ data: {} })).toBeUndefined();
    expect(parseOpenRouterBalance({ data: { limit: null, usage: 3 } })).toEqual({
      balances: undefined,
      limit: undefined,
      unlimited: true,
      used: 3,
    });
  });

  it('does not reuse cached balance after the provider or credential changes', async () => {
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        url,
      });
      return new Response(
        JSON.stringify(
          url.includes('deepseek')
            ? {
                balance_infos: [{ currency: 'CNY', total_balance: '9.00' }],
                is_available: true,
              }
            : { data: { limit: 20, usage: 5 } },
        ),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    };
    const service = new ProviderResourceUsageService(fetchImplementation);

    const deepSeek = await service.read('project', 'deepseek', 'secret-a');
    const openRouter = await service.read('project', 'openrouter', 'secret-b');
    const changedCredential = await service.read('project', 'openrouter', 'secret-c');

    expect(deepSeek?.balance?.balances).toEqual([{ amount: 9, currency: 'CNY' }]);
    expect(openRouter?.balance?.balances).toEqual([{ amount: 15, currency: 'USD' }]);
    expect(changedCredential?.balance?.balances).toEqual([{ amount: 15, currency: 'USD' }]);
    expect(requests).toEqual([
      { authorization: 'Bearer secret-a', url: 'https://api.deepseek.com/user/balance' },
      { authorization: 'Bearer secret-b', url: 'https://openrouter.ai/api/v1/key' },
      { authorization: 'Bearer secret-c', url: 'https://openrouter.ai/api/v1/key' },
    ]);
  });
});
