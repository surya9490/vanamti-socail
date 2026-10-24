"use client";

import { cn } from "@/lib/utils";
import type {
  Message,
  MessageReaction,
  MessageTemplate,
  TemplateButton,
  TemplateMessagePayload,
} from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
  Reply,
  ExternalLink,
  Phone,
  Copy,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from "./message-media";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import {
  templateMessageView,
  type TemplateMessageHeader,
} from "@/lib/whatsapp/template-message-view";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  template?: MessageTemplate | null;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  onToggleReaction?: (emoji: string) => void;
  /**
   * Opens the thread's media viewer on this message. Only images and videos
   * call it; omitted when the parent renders no viewer, in which case media
   * stays inline and non-clickable.
   */
  onOpenMedia?: (messageId: string) => void;
}

/**
 * "[title] — [details]" for a failed message, or null when the row
 * predates migration 042 / Meta sent no reason. Shared by the status
 * icon's tooltip and the line under the bubble.
 */
/** InteractivePreview with the empty-state labels in the UI language. */
function LocalizedInteractivePreview({
  payload,
}: {
  payload: NonNullable<Message["interactive_payload"]>;
}) {
  const t = useTranslations("Interactive");
  return (
    <InteractivePreview
      payload={payload}
      labels={{
        body: t("previewBody"),
        button: t("previewButton"),
        menu: t("previewMenu"),
      }}
    />
  );
}

const TEMPLATE_BUTTON_ICONS: Record<TemplateButton["type"], LucideIcon> = {
  QUICK_REPLY: Reply,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
};

function TemplateHeader({
  header,
  message,
  t,
}: {
  header: TemplateMessageHeader;
  message: Message;
  t: ReturnType<typeof useTranslations>;
}) {
  if (header.type === "text") {
    return (
      <p className="mt-1 break-words text-sm font-semibold">{header.text}</p>
    );
  }
  if (!header.url) {
    const label =
      header.type === "image"
        ? t("photo")
        : header.type === "video"
          ? t("video")
          : t("document");
    return (
      <div className="mt-1">
        <MediaUnavailable label={label} t={t} />
      </div>
    );
  }
  const media = { ...message, media_url: header.url };
  return (
    <div className="mt-1">
      {header.type === "image" ? (
        <MediaImageBubble message={media} t={t} />
      ) : header.type === "video" ? (
        <MediaVideoBubble message={media} t={t} />
      ) : (
        <MediaDocumentBubble message={media} t={t} />
      )}
    </div>
  );
}

function failureReason(message: Message): string | null {
  if (message.status !== "failed" || !message.error_title) return null;
  return message.error_details
    ? `${message.error_title} — ${message.error_details}`
    : message.error_title;
}

/** "vanamati.com/cart?magic_order_id=…" — enough of the URL to recognise it. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * Header image, footer and buttons of a sent template, as the customer's
 * phone shows them (messages.template_payload, migration 061). URL buttons
 * are real links and show where they go, so an agent can see — and open —
 * the exact link the customer was given.
 */
function TemplateExtras({
  payload,
  isAgent,
  children,
}: {
  payload: TemplateMessagePayload;
  isAgent: boolean;
  children: React.ReactNode;
}) {
  const header = payload.header;
  const divider = isAgent ? "border-primary-foreground/20" : "border-border";
  const subtle = isAgent ? "text-primary-foreground/70" : "text-muted-foreground";

  return (
    <div className="max-w-72">
      {header?.format === "image" && (
        <a href={header.link} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- external CDN image, any host */}
          <img
            src={header.link}
            alt=""
            loading="lazy"
            className="mb-1 max-h-64 w-full rounded-lg object-cover"
          />
        </a>
      )}
      {header?.format === "video" && (
        <video
          src={header.link}
          controls
          preload="metadata"
          className="mb-1 max-h-64 w-full rounded-lg"
        />
      )}
      {header?.format === "document" && (
        <a
          href={header.link}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-1 flex items-center gap-2 text-sm underline-offset-2 hover:underline"
        >
          <FileText className="h-4 w-4 shrink-0" />
          <span className="truncate">{shortUrl(header.link)}</span>
        </a>
      )}
      {header?.format === "text" && (
        <p className="mb-0.5 break-words text-sm font-semibold">{header.text}</p>
      )}

      {children}

      {payload.footer && (
        <p className={cn("mt-1 break-words text-[11px]", subtle)}>{payload.footer}</p>
      )}

      {payload.buttons && payload.buttons.length > 0 && (
        <div className={cn("mt-2 border-t", divider)}>
          {payload.buttons.map((button, index) => {
            const row = cn(
              "flex w-full items-start gap-2 border-b py-1.5 text-left text-sm last:border-b-0",
              divider,
            );
            if (button.type === "URL") {
              return (
                <a
                  key={index}
                  href={button.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={button.url}
                  className={cn(row, "hover:opacity-80")}
                >
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-medium">{button.text}</span>
                    <span className={cn("block break-all text-[11px]", subtle)}>
                      {shortUrl(button.url)}
                    </span>
                  </span>
                </a>
              );
            }
            if (button.type === "PHONE_NUMBER") {
              return (
                <a key={index} href={`tel:${button.phone_number}`} className={row}>
                  <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-medium">{button.text}</span>
                    <span className={cn("block text-[11px]", subtle)}>
                      {button.phone_number}
                    </span>
                  </span>
                </a>
              );
            }
            if (button.type === "COPY_CODE") {
              return (
                <div key={index} className={row}>
                  <Copy className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-medium">{button.text}</span>
                    <span className={cn("block font-mono text-[11px]", subtle)}>
                      {button.code}
                    </span>
                  </span>
                </div>
              );
            }
            return (
              <div key={index} className={row}>
                <Reply className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="font-medium">{button.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusIcon({
  status,
  title,
}: {
  status: Message["status"];
  /** Tooltip for the failed state — Meta's reason, when we have one. */
  title?: string | null;
}) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return (
        <span className="inline-flex" title={title ?? undefined}>
          <XCircle className="h-3 w-3 text-red-400" />
        </span>
      );
    default:
      return null;
  }
}

function MessageContent({
  message,
  template,
  t,
  isAgent,
  onOpenMedia,
}: {
  message: Message;
  template: MessageTemplate | null;
  t: ReturnType<typeof useTranslations>;
  /** Outbound bubbles sit on the primary fill — badges must invert. */
  isAgent: boolean;
  onOpenMedia?: (messageId: string) => void;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImageBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideoBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <MediaAudioBubble message={message} t={t} />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return <MediaDocumentBubble message={message} t={t} />;

    case "template": {
      // Templates are almost always outbound, where the bubble fill IS
      // `primary` — so the old `bg-primary/20 text-primary` chip was
      // primary-on-primary and invisible. Paired with a null
      // content_text (issue #483) that rendered a bubble with nothing
      // in it at all. Invert on the primary fill, and fall back to the
      // template's name when we have no stored body (legacy rows sent
      // before the fix).
      const view = templateMessageView(message, template);
      return (
        <div>
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              isAgent
                ? "bg-primary-foreground/20 text-primary-foreground"
                : "bg-primary/20 text-primary",
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {(() => {
            const body = message.content_text ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {message.content_text}
              </p>
            ) : (
              message.template_name && (
                <p className="mt-1 break-words text-sm italic opacity-80">
                  {message.template_name}
                </p>
              )
            );
            // Sends since migration 061 store the header, footer and buttons
            // with their per-send URLs — render those. Older rows (and sends
            // that don't store a payload) fall back to the local template.
            if (message.template_payload) {
              return (
                <TemplateExtras payload={message.template_payload} isAgent={isAgent}>
                  {body}
                </TemplateExtras>
              );
            }
            return (
              <>
                {view.header && (
                  <TemplateHeader header={view.header} message={message} t={t} />
                )}
                {body}
                {view.footer && (
                  <p
                    className={cn(
                      "mt-1 break-words text-[11px]",
                      isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    {view.footer}
                  </p>
                )}
                {view.buttons.length > 0 && (
                  <div
                    className={cn(
                      "mt-2 flex flex-col border-t",
                      isAgent ? "border-primary-foreground/20" : "border-border",
                    )}
                  >
                    {view.buttons.map((button, i) => {
                      const Icon = TEMPLATE_BUTTON_ICONS[button.type];
                      return (
                        <span
                          key={i}
                          className={cn(
                            "flex items-center justify-center gap-1.5 border-t py-1.5 text-sm font-medium first:border-t-0",
                            isAgent
                              ? "border-primary-foreground/20 text-primary-foreground"
                              : "border-border text-primary",
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{button.text}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      );
    }

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <LocalizedInteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  template = null,
  reply,
  reactions,
  onToggleReaction,
  onOpenMedia,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");
  const failure = isAgent ? failureReason(message) : null;

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent
          message={message}
          template={template}
          t={t}
          isAgent={isAgent}
          onOpenMedia={onOpenMedia}
        />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} title={failure} />}
        </div>
        {/*
          Failed-send diagnostic. Meta returns an error code + human
          message when a send fails at the platform (template param
          count mismatch, closed 24h window, opted-out recipient, …).
          Migration 028 persists these on messages.error_*; showing
          them here saves the agent from bouncing to Meta's console
          just to know WHY a bubble is red-X'd.
        */}
        {isAgent && message.status === "failed" && message.error_message && (
          <div
            className="mt-1 max-w-65 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] leading-snug text-red-300"
            title={message.error_title ?? undefined}
          >
            <span className="font-semibold">
              Failed{message.error_code ? ` (#${message.error_code})` : ""}:
            </span>{" "}
            {message.error_message}
          </div>
        )}
      </div>
      {failure && (
        <p
          className="mt-0.5 px-1 text-[10px] leading-tight text-muted-foreground"
          title={failure}
        >
          {t("notDelivered")}: {failure}
        </p>
      )}
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
