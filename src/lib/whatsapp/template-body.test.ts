import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  renderTemplateBody,
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
  templateMessagePayload,
} from './template-body';
import type { MessageTemplate } from '@/types';

function row(over: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: 'tpl-1',
    user_id: 'u-1',
    name: 'order_update',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Your order {{1}} ships on {{2}}',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  } as MessageTemplate;
}

/**
 * Minimal `from().select().eq().eq()` thenable — the same surface
 * resolveTemplateRow uses. Records the filters so a test can assert
 * the lookup is account-scoped.
 */
function dbReturning(
  rows: unknown[],
  filters: Record<string, unknown> = {}
): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    then: (resolve: (r: { data: unknown[] }) => unknown) =>
      resolve({ data: rows }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe('renderTemplateBody', () => {
  it('substitutes positional placeholders', () => {
    expect(
      renderTemplateBody('Your order {{1}} ships on {{2}}', ['A123', 'Friday'])
    ).toBe('Your order A123 ships on Friday');
  });

  it('leaves a placeholder visible when the param is missing', () => {
    expect(renderTemplateBody('Hi {{1}}, code {{2}}', ['Sam'])).toBe(
      'Hi Sam, code {{2}}'
    );
  });

  it('handles a body with no placeholders and repeated indexes', () => {
    expect(renderTemplateBody('No variables here', ['x'])).toBe(
      'No variables here'
    );
    expect(renderTemplateBody('{{1}} and {{1}}', ['twice'])).toBe(
      'twice and twice'
    );
  });
});

describe('templateBodyParams', () => {
  it('prefers structured body values over the legacy array', () => {
    expect(templateBodyParams(['legacy'], { body: ['structured'] })).toEqual([
      'structured',
    ]);
  });

  it('falls back to the legacy array when structured body is absent', () => {
    expect(templateBodyParams(['a', 'b'], { headerText: 'x' })).toEqual([
      'a',
      'b',
    ]);
    expect(templateBodyParams(['a'], undefined)).toEqual(['a']);
  });

  it('returns an empty array for junk input', () => {
    expect(templateBodyParams(null, null)).toEqual([]);
    expect(templateBodyParams(undefined, { body: 'not-an-array' })).toEqual([]);
  });

  it('drops non-string entries from the structured body', () => {
    expect(templateBodyParams([], { body: ['ok', 7, null] })).toEqual(['ok']);
  });
});

describe('resolveTemplateRow', () => {
  it('scopes the lookup to the account and template name', async () => {
    const filters: Record<string, unknown> = {};
    await resolveTemplateRow(
      dbReturning([row({})], filters),
      'acct-1',
      'order_update',
      'en_US'
    );
    expect(filters).toEqual({ account_id: 'acct-1', name: 'order_update' });
  });

  it("matches a synced 'en' row when the caller asks for 'en_US' (#483)", async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([row({ language: 'en' })]),
      'acct-1',
      'order_update',
      'en_US'
    );
    expect(resolved.row?.language).toBe('en');
    // Caller pinned a language — that is what Meta is sent.
    expect(resolved.language).toBe('en_US');
  });

  it("resolves a bare 'en' row when the caller omits the language, and sends 'en'", async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([row({ language: 'en' })]),
      'acct-1',
      'order_update',
      null
    );
    expect(resolved.row?.language).toBe('en');
    // The old code pinned 'en_US' here, which Meta rejects as a
    // missing translation.
    expect(resolved.language).toBe('en');
  });

  it('prefers an exact language match over a base-language sibling', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([
        row({ id: 'a', language: 'en' }),
        row({ id: 'b', language: 'en_GB' }),
      ]),
      'acct-1',
      'order_update',
      'en_GB'
    );
    expect(resolved.row?.id).toBe('b');
  });

  it('prefers en_US then en when no language is requested', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([
        row({ id: 'es', language: 'es' }),
        row({ id: 'us', language: 'en_US' }),
        row({ id: 'en', language: 'en' }),
      ]),
      'acct-1',
      'order_update'
    );
    expect(resolved.row?.id).toBe('us');
  });

  it('returns no row when the account has none, keeping the requested language', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([]),
      'acct-1',
      'missing',
      'fr'
    );
    expect(resolved).toEqual({ row: null, malformed: false, language: 'fr' });
  });

  it('reports a row that matched by name but fails the shape guard', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([{ id: 'tpl-1', language: 'en_US' /* no body_text */ }]),
      'acct-1',
      'order_update',
      'en_US'
    );
    expect(resolved.malformed).toBe(true);
    expect(resolved.row).toBeNull();
  });

  it('sends the caller-pinned language even when no local row matches it', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([row({ language: 'es' })]),
      'acct-1',
      'order_update',
      'de'
    );
    expect(resolved.row).toBeNull();
    expect(resolved.language).toBe('de');
  });
});

describe('templateContentText', () => {
  it('renders the substituted body from the local row', () => {
    expect(templateContentText(row({}), ['A123', 'Friday'])).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it("prefers the caller's pre-rendered text (the dashboard composer)", () => {
    expect(
      templateContentText(row({}), ['A123', 'Friday'], 'composer rendered')
    ).toBe('composer rendered');
  });

  it('is null when there is no local row to render from', () => {
    expect(templateContentText(null, ['A123'])).toBeNull();
  });
});

describe('templateMessagePayload', () => {
  const cart = row({
    name: 'cart_recovery_v2',
    header_type: 'image',
    header_media_url: 'https://cdn.example.com/sample.png',
    body_text: 'Hi {{1}}, you left {{2}} in your cart worth ₹{{3}}.',
    footer_text: 'www.vanamati.com',
    buttons: [
      {
        type: 'URL',
        text: 'Complete your order',
        url: 'https://vanamati.com/{{1}}',
        example: 'https://vanamati.com/cart',
      },
    ],
  });

  it('records the header image, footer and the button URL this send used', () => {
    expect(
      templateMessagePayload(cart, {
        body: ['Anita', '1x Ghee', '549'],
        headerMediaUrl: 'https://cdn.example.com/ghee.png?width=800',
        buttonParams: ['cart?magic_order_id=abc&utm_source=whatsapp'],
      })
    ).toEqual({
      header: {
        format: 'image',
        link: 'https://cdn.example.com/ghee.png?width=800',
      },
      footer: 'www.vanamati.com',
      buttons: [
        {
          type: 'URL',
          text: 'Complete your order',
          url: 'https://vanamati.com/cart?magic_order_id=abc&utm_source=whatsapp',
        },
      ],
    });
  });

  it("falls back to the row's sample media, like the send builder", () => {
    expect(templateMessagePayload(cart, {})?.header).toEqual({
      format: 'image',
      link: 'https://cdn.example.com/sample.png',
    });
  });

  it('accepts buttonParams keyed by index as an object too', () => {
    expect(
      templateMessagePayload(cart, { buttonParams: { 0: 'products/honey' } })
        ?.buttons?.[0]
    ).toMatchObject({ url: 'https://vanamati.com/products/honey' });
  });

  it('leaves {{1}} visible when a URL button got no value', () => {
    expect(templateMessagePayload(cart)?.buttons?.[0]).toMatchObject({
      url: 'https://vanamati.com/{{1}}',
    });
  });

  it('renders a text header and every button kind', () => {
    const t = row({
      header_type: 'text',
      header_content: 'Order {{1}} shipped',
      buttons: [
        {
          type: 'PHONE_NUMBER',
          text: 'Call us',
          phone_number: '+911234567890',
        },
        { type: 'COPY_CODE', text: 'Copy code', example: 'WELCOME10' },
        { type: 'QUICK_REPLY', text: 'Stop' },
      ],
    });
    expect(
      templateMessagePayload(t, {
        headerText: '#1044',
        buttonParams: { 1: 'SAVE20' },
      })
    ).toEqual({
      header: { format: 'text', text: 'Order #1044 shipped' },
      buttons: [
        {
          type: 'PHONE_NUMBER',
          text: 'Call us',
          phone_number: '+911234567890',
        },
        { type: 'COPY_CODE', text: 'Copy code', code: 'SAVE20' },
        { type: 'QUICK_REPLY', text: 'Stop' },
      ],
    });
  });

  it('is null for a body-only template or no local row', () => {
    expect(templateMessagePayload(row({}))).toBeNull();
    expect(templateMessagePayload(null, { buttonParams: ['x'] })).toBeNull();
  });
});
