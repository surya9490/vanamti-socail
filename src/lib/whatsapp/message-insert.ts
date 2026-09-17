// ============================================================
// Recording a sent message when the schema may lag the code.
//
// Migrations in this repo are applied by hand (docs/docker.md), so a
// deploy can reach production before `messages.template_payload`
// (migration 061) exists. PostgREST then rejects the whole insert with
// PGRST204 — and by that point Meta has already delivered the message,
// so the send would be reported as failed and never shown in the Inbox.
// Retrying once without the column keeps the send recorded; only the
// rendered header/buttons are lost until the migration is applied.
// ============================================================

type InsertResult = { error: { code?: string; message: string } | null };

function isMissingTemplatePayloadColumn(error: {
  code?: string;
  message: string;
}): boolean {
  return (
    error.code === 'PGRST204' && error.message.includes('template_payload')
  );
}

export async function insertWithTemplatePayloadFallback<T extends InsertResult>(
  row: Record<string, unknown>,
  run: (row: Record<string, unknown>) => PromiseLike<T>
): Promise<T> {
  const result = await run(row);
  if (
    result.error &&
    'template_payload' in row &&
    isMissingTemplatePayloadColumn(result.error)
  ) {
    console.warn(
      '[messages] template_payload column missing — apply supabase/migrations/061_message_template_payload.sql'
    );
    const withoutPayload = { ...row };
    delete withoutPayload.template_payload;
    return run(withoutPayload);
  }
  return result;
}
