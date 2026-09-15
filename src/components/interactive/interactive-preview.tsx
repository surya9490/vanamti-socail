"use client";

import { List, Reply, ShoppingBag, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";

function formatPrice(price: number | null | undefined, currency: string | null | undefined): string {
  if (price == null) return "";
  const c = currency ?? "INR";
  return c === "INR" ? `₹${price}` : `${c} ${price}`;
}

/**
 * Ask Shopify's CDN for a small thumbnail instead of the full-size
 * master file. Our product images are stored as-is from Shopify (some
 * are 5-10 MB PNGs); rendering them as 36px avatars was pulling the
 * whole file over the wire. Shopify accepts `?width=N` on any
 * `cdn.shopify.com` URL and returns a scaled variant.
 *
 * Non-Shopify hosts are returned unchanged.
 */
function thumbUrl(src: string | null | undefined, targetPx: number): string | undefined {
  if (!src) return undefined;
  try {
    const url = new URL(src);
    if (!/(^|\.)cdn\.shopify\.com$/.test(url.hostname)) return src;
    // Ask for a slightly larger image than the render size so 2x
    // DPI screens still get a crisp result.
    url.searchParams.set("width", String(targetPx * 2));
    return url.toString();
  } catch {
    return src;
  }
}

/**
 * WhatsApp-style read-only render of an interactive message. Used both
 * in the builder's live preview and by the inbox message bubble so a
 * sent buttons/list message shows the same way it does on the phone.
 *
 * Purely presentational — the buttons/rows are not clickable here (the
 * customer taps them on their own device). Kept namespace-free so it can
 * be dropped into the composer, the automation builder, and the
 * quick-replies manager without namespace coupling: the three fallback
 * labels shown for empty fields default to plain English, and a host
 * that has a translator can pass its own via `labels`.
 */
export interface InteractivePreviewLabels {
  /** Shown in place of an empty body. */
  body?: string;
  /** Shown in place of an untitled reply button. */
  button?: string;
  /** Shown in place of an empty list button label. */
  menu?: string;
}

export function InteractivePreview({
  payload,
  className,
  labels,
}: {
  payload: InteractiveMessagePayload;
  className?: string;
  labels?: InteractivePreviewLabels;
}) {
  const bodyLabel = labels?.body ?? "Message body…";
  const buttonLabel = labels?.button ?? "Button";
  const menuLabel = labels?.menu ?? "Menu";

  // product_list — the "Send catalogue" flow. Renders a compact
  // vertical list of the product cards the customer actually saw
  // (title + price + tiny image thumbnail), so agents in the inbox
  // can tell what got sent.
  if (payload.kind === "product_list") {
    const totalCount = payload.sections.reduce(
      (a, s) => a + s.products.length,
      0,
    );
    return (
      <div
        className={cn(
          "w-full max-w-[300px] overflow-hidden rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border",
          className,
        )}
      >
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <ShoppingBag className="h-3 w-3" />
          Catalog · {totalCount} {totalCount === 1 ? "product" : "products"}
        </div>
        <div className="px-3 py-2">
          {payload.header ? (
            <p className="mb-1 break-words text-sm font-semibold">
              {payload.header}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap break-words text-sm">
            {payload.body || (
              <span className="text-muted-foreground">{bodyLabel}</span>
            )}
          </p>
        </div>
        <div className="border-t border-border">
          {payload.sections.map((section, si) => (
            <div key={si}>
              {section.title ? (
                <div className="border-b border-border bg-muted/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.title}
                </div>
              ) : null}
              {section.products.map((p) => (
                <div
                  key={p.retailer_id}
                  className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                >
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbUrl(p.image_url, 36)}
                      alt=""
                      width={36}
                      height={36}
                      loading="lazy"
                      decoding="async"
                      className="h-9 w-9 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted">
                      <ImageIcon className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {p.title || p.retailer_id}
                    </p>
                    {p.price != null ? (
                      <p className="text-[11px] text-muted-foreground">
                        {formatPrice(p.price, p.currency)}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        {payload.footer ? (
          <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            {payload.footer}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "w-full max-w-[260px] overflow-hidden rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border",
        className,
      )}
    >
      <div className="px-3 py-2">
        {payload.header ? (
          <p className="mb-1 break-words text-sm font-semibold">
            {payload.header}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words text-sm">
          {payload.body || (
            <span className="text-muted-foreground">{bodyLabel}</span>
          )}
        </p>
        {payload.footer ? (
          <p className="mt-1 break-words text-[11px] text-muted-foreground">
            {payload.footer}
          </p>
        ) : null}
      </div>

      {payload.kind === "buttons" ? (
        <div className="flex flex-col border-t border-border">
          {payload.buttons.map((b, i) => (
            <button
              key={b.id || i}
              type="button"
              disabled
              className="flex items-center justify-center gap-1.5 border-t border-border py-2 text-sm font-medium text-primary first:border-t-0"
            >
              <Reply className="h-3.5 w-3.5" />
              <span className="truncate">{b.title || buttonLabel}</span>
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          disabled
          className="flex w-full items-center justify-center gap-1.5 border-t border-border py-2 text-sm font-medium text-primary"
        >
          <List className="h-3.5 w-3.5" />
          <span className="truncate">{payload.button_label || menuLabel}</span>
        </button>
      )}
    </div>
  );
}
