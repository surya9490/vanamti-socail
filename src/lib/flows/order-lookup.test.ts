import { describe, it, expect } from "vitest";

import { isAutoAdvancing, resolveOrderLookupNumber, TRIGGER_TEXT_VAR } from "./engine";
import {
  applyEdgeConnection,
  deriveCanvasEdges,
  outgoingSlots,
  unlinkNodeReferences,
} from "./edges";
import { validateFlowForActivation } from "./validate";
import type { BuilderNode } from "@/components/flows/shared";

// ============================================================
// resolveOrderLookupNumber — the "Both (most robust)" priority:
// configured var → triggering message → nothing.
// ============================================================

describe("resolveOrderLookupNumber", () => {
  it("prefers the configured var over the trigger message", () => {
    const n = resolveOrderLookupNumber(
      { order_var: "order_number" },
      { order_number: "#1024", [TRIGGER_TEXT_VAR]: "track 9999" },
    );
    expect(n).toBe("1024");
  });

  it("falls back to the trigger message when the var is empty/absent", () => {
    expect(
      resolveOrderLookupNumber(
        { order_var: "order_number" },
        { [TRIGGER_TEXT_VAR]: "where is my order 5567" },
      ),
    ).toBe("5567");
    // No order_var configured at all → still reads the trigger message.
    expect(
      resolveOrderLookupNumber({}, { [TRIGGER_TEXT_VAR]: "status #AB-77" }),
    ).toBe("AB-77");
  });

  it("returns null when neither source yields an order number", () => {
    expect(resolveOrderLookupNumber({ order_var: "x" }, {})).toBeNull();
    expect(
      resolveOrderLookupNumber({}, { [TRIGGER_TEXT_VAR]: "hello there" }),
    ).toBeNull();
  });

  it("normalises a bare captured number", () => {
    expect(
      resolveOrderLookupNumber({ order_var: "o" }, { o: "1042" }),
    ).toBe("1042");
  });
});

// ============================================================
// Engine classification — order_lookup is a synchronous send+advance
// node, so it must auto-advance (not suspend / terminate).
// ============================================================

describe("isAutoAdvancing", () => {
  it("classifies order_lookup as auto-advancing", () => {
    expect(isAutoAdvancing("order_lookup")).toBe(true);
  });
});

// ============================================================
// Canvas edge wiring — order_lookup has a single `next` slot, exactly
// like send_message / set_tag.
// ============================================================

function nodes(...ns: BuilderNode[]): BuilderNode[] {
  return ns;
}

describe("order_lookup canvas edges", () => {
  it("derives a single `next` edge", () => {
    const edges = deriveCanvasEdges(
      nodes(
        {
          node_key: "ol",
          node_type: "order_lookup",
          config: { order_var: "order_number", next_node_key: "done" },
        },
        { node_key: "done", node_type: "end", config: {} },
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: "ol",
      target: "done",
      sourceHandle: "next",
    });
  });

  it("exposes exactly one outgoing slot", () => {
    expect(
      outgoingSlots({
        node_key: "ol",
        node_type: "order_lookup",
        config: { next_node_key: "done" },
      }),
    ).toEqual([{ id: "next", label: "Next" }]);
  });

  it("wires a dragged `next` connection into next_node_key", () => {
    expect(
      applyEdgeConnection(
        { node_key: "ol", node_type: "order_lookup", config: {} },
        "next",
        "target",
      ),
    ).toEqual({ next_node_key: "target" });
  });

  it("clears its next_node_key when the target node is deleted", () => {
    const [patched] = unlinkNodeReferences(
      nodes({
        node_key: "ol",
        node_type: "order_lookup",
        config: { order_var: "o", next_node_key: "gone" },
      }),
      "gone",
    );
    expect(patched.config.next_node_key).toBe("");
    // Unrelated config is preserved.
    expect(patched.config.order_var).toBe("o");
  });
});

// ============================================================
// Save-time validation.
// ============================================================

const baseFlow = {
  name: "Order tracking",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["track"] },
  entry_node_id: "start",
};

function flowWith(orderLookupConfig: Record<string, unknown>) {
  return validateFlowForActivation(baseFlow, [
    { node_key: "start", node_type: "start", config: { next_node_key: "ol" } },
    { node_key: "ol", node_type: "order_lookup", config: orderLookupConfig },
    { node_key: "done", node_type: "end", config: {} },
  ]);
}

describe("validateFlowForActivation — order_lookup", () => {
  it("accepts a node with just a next_node_key (order_var optional)", () => {
    expect(flowWith({ next_node_key: "done" })).toEqual([]);
  });

  it("accepts a valid order_var identifier", () => {
    expect(flowWith({ order_var: "order_number", next_node_key: "done" })).toEqual(
      [],
    );
  });

  it("flags a missing next_node_key", () => {
    const issues = flowWith({ order_var: "o" });
    expect(
      issues.some((i) => i.node_key === "ol" && i.field === "next_node_key"),
    ).toBe(true);
  });

  it("flags a next_node_key that points nowhere", () => {
    const issues = flowWith({ next_node_key: "ghost" });
    expect(
      issues.some(
        (i) =>
          i.node_key === "ol" &&
          i.field === "next_node_key" &&
          /non-existent/.test(i.message),
      ),
    ).toBe(true);
  });

  it("flags an invalid order_var identifier", () => {
    const issues = flowWith({ order_var: "1bad", next_node_key: "done" });
    expect(
      issues.some((i) => i.node_key === "ol" && i.field === "order_var"),
    ).toBe(true);
  });
});
