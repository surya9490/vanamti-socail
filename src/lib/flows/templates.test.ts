import { describe, it, expect } from "vitest";
import { listFlowTemplates } from "./templates";
import { validateFlowForActivation } from "./validate";

// Every starter template must be structurally valid — no broken edges,
// no over-length button/list titles, no >10-row lists, no unreachable
// nodes. The one allowed "error" is an empty send_media `media_url`: the
// Vanamati order template ships with the payment QR unset on purpose (the
// owner uploads their own QR in the builder before activating).
describe("flow templates", () => {
  for (const template of listFlowTemplates()) {
    it(`"${template.slug}" is valid for activation`, () => {
      const issues = validateFlowForActivation(
        {
          name: template.name,
          trigger_type: template.trigger_type,
          trigger_config: template.trigger_config as Record<string, unknown>,
          entry_node_id: template.entry_node_id,
        },
        template.nodes.map((n) => ({
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config as Record<string, unknown>,
        })),
      );

      const blockingErrors = issues.filter(
        (i) => i.severity === "error" && i.field !== "media_url",
      );
      const unreachable = issues.filter((i) =>
        i.message.toLowerCase().includes("unreachable"),
      );

      expect(blockingErrors).toEqual([]);
      expect(unreachable).toEqual([]);
    });
  }
});
