/**
 * The name the assistant may greet a customer by. `contacts.name` is
 * usually the WhatsApp push name, which is often a handle ("crspingalay",
 * "karthik army07", "sg_ganesh") — "Glad it reached you safely,
 * crspingalay!" reads wrong. Only something that looks like a person's name
 * is used; otherwise the assistant greets without a name.
 */
export function displayNameForPrompt(raw: string | null | undefined): string | null {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return null
  if (/[@\d_]/.test(name)) return null // email, digits, underscores → a handle
  if (/^\+?\d[\d\s-]*$/.test(name)) return null // a phone number
  const words = name.split(' ')
  // A single all-lowercase token is a handle, not a name ("crspingalay").
  if (words.length === 1 && name === name.toLowerCase()) return null
  return name
}
