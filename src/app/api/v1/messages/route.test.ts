import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eqCalls: [] as [string, unknown][],
  inCalls: [] as [string, unknown][],
  rows: [] as unknown[],
}));

function fakeSupabase() {
  const builder: Record<string, unknown> = {
    select: () => builder,
    in: (column: string, values: unknown) => {
      mocks.inCalls.push([column, values]);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      mocks.eqCalls.push([column, value]);
      return builder;
    },
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: mocks.rows, error: null }),
  };
  return { from: () => builder };
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({
    supabase: fakeSupabase(),
    accountId: 'account-1',
  })),
}));

import { requireApiKey } from '@/lib/auth/api-context';
import { GET } from './route';

const A = '3f2b8c1e-9a4d-4e2f-b6a1-0c9d8e7f6a5b';
const B = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

const get = (query: string) => GET(new Request(`https://x.test/api/v1/messages${query}`));

describe('GET /api/v1/messages', () => {
  beforeEach(() => {
    mocks.eqCalls = [];
    mocks.inCalls = [];
    mocks.rows = [];
  });

  it('needs the messages:read scope', async () => {
    await get(`?ids=${A}`);
    expect(requireApiKey).toHaveBeenCalledWith(expect.any(Request), 'messages:read');
  });

  it('rejects a request without ids', async () => {
    const res = await get('');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('rejects an id that is not a UUID', async () => {
    const res = await get(`?ids=${A},abc`);
    expect(res.status).toBe(400);
  });

  it('rejects more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const res = await get(`?ids=${ids.join(',')}`);
    expect(res.status).toBe(400);
  });

  it("reads only the key's account's messages, each id once", async () => {
    await get(`?ids=${A},${B},${A}`);
    expect(mocks.inCalls).toContainEqual(['id', [A, B]]);
    expect(mocks.eqCalls).toContainEqual(['conversations.account_id', 'account-1']);
  });

  it("returns each message's status and Meta's reason for a failure", async () => {
    mocks.rows = [
      { id: A, message_id: 'wamid.1', status: 'read', error_code: null, error_title: null, error_details: null },
      {
        id: B,
        message_id: 'wamid.2',
        status: 'failed',
        error_code: '131049',
        error_title: 'This message was not delivered to maintain healthy ecosystem engagement.',
        error_details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      },
    ];
    const res = await get(`?ids=${A},${B}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      { id: A, whatsapp_message_id: 'wamid.1', status: 'read', error_code: null, error_title: null, error_details: null },
      {
        id: B,
        whatsapp_message_id: 'wamid.2',
        status: 'failed',
        error_code: 131049,
        error_title: 'This message was not delivered to maintain healthy ecosystem engagement.',
        error_details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      },
    ]);
  });
});
