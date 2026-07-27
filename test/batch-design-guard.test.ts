import { describe, expect, it } from "vitest";
import {
  nodeTypeOfCreateOp,
  isCreateOp,
  makeBatchDesignInputSchema,
} from "../src/ai/tools.js";

describe("nodeTypeOfCreateOp", () => {
  it("extracts the top-level type from an I() insert", () => {
    expect(nodeTypeOfCreateOp('x=I(document,{type:"frame"})')).toBe("frame");
  });

  it("extracts the top-level type from an I() insert with more props", () => {
    expect(
      nodeTypeOfCreateOp('x=I(document,{type:"embed",name:"A"})'),
    ).toBe("embed");
  });

  it("extracts the top-level type from a bare (unbound) R() replace", () => {
    expect(nodeTypeOfCreateOp('R("p/c",{type:"rect"})')).toBe("rect");
  });

  it("returns null for U() — not a create op", () => {
    expect(nodeTypeOfCreateOp('U("id",{content:"x"})')).toBeNull();
  });

  it("returns null for D() — not a create op", () => {
    expect(nodeTypeOfCreateOp('D("id")')).toBeNull();
  });

  it("returns null for G() — not a create op", () => {
    expect(nodeTypeOfCreateOp('G(hero,"ai","x")')).toBeNull();
  });

  it("returns null for C() and M() — not create-with-type ops", () => {
    expect(nodeTypeOfCreateOp('c=C("srcId",document,{})')).toBeNull();
    expect(nodeTypeOfCreateOp('M("nodeId",document,0)')).toBeNull();
  });

  it("is not confused by a nested `type` inside fills/effects paint objects", () => {
    expect(
      nodeTypeOfCreateOp(
        'x=I(document,{type:"embed",fills:[{type:"solid",color:"#fff"}]})',
      ),
    ).toBe("embed");
  });

  it("returns null when there is no top-level type key", () => {
    expect(nodeTypeOfCreateOp('x=I(document,{name:"A"})')).toBeNull();
  });

  it("returns null for statements that are not I()/R() at all", () => {
    expect(nodeTypeOfCreateOp("snapshot")).toBeNull();
    expect(nodeTypeOfCreateOp("// a comment")).toBeNull();
  });
});

describe("isCreateOp", () => {
  it("is true for I()/R() statements, with or without a binding", () => {
    expect(isCreateOp('x=I(document,{type:"frame"})')).toBe(true);
    expect(isCreateOp('I(document,{type:"frame"})')).toBe(true);
    expect(isCreateOp('R("p/c",{type:"rect"})')).toBe(true);
  });

  it("is false for non-create operators", () => {
    expect(isCreateOp('U("id",{content:"x"})')).toBe(false);
    expect(isCreateOp('D("id")')).toBe(false);
    expect(isCreateOp('G(hero,"ai","x")')).toBe(false);
    expect(isCreateOp('C("id",document,{...})')).toBe(false);
  });
});

describe("makeBatchDesignInputSchema({ embedOnly: true })", () => {
  const schema = makeBatchDesignInputSchema({ embedOnly: true });

  it("accepts a top-level embed insert", () => {
    const result = schema.safeParse({
      operations: 'embed=I(document, {type: "embed", name: "Screen"})',
    });
    expect(result.success).toBe(true);
  });

  it("rejects a native frame insert with an embed-only message", () => {
    const result = schema.safeParse({
      operations: 'x=I(document, {type: "frame"})',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("embed-only");
    }
  });

  it("still succeeds with a multi-line htmlContent embed op", () => {
    const operations = [
      'embed=I(document, {type: "embed", name: "Screen", htmlContent: "<div>',
      "multi",
      "line",
      '</div>"})',
    ].join("\n");
    expect(schema.safeParse({ operations }).success).toBe(true);
  });

  it("no longer rejects a script over the 25-op limit — truncation is now handled client-side", () => {
    const ops = Array.from({ length: 26 }, (_, i) => `D("node${i}")`).join(
      "\n",
    );
    const result = schema.safeParse({ operations: ops });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.operations).toBe(ops);
    }
  });

  it("rejects a type-less insert — the frontend defaults a missing type to a native frame", () => {
    const result = schema.safeParse({
      operations: 's=I(document, {name: "Home", htmlContent: "<div>x</div>"})',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("embed-only");
    }
  });

  it("rejects a type-less replace the same way", () => {
    const result = schema.safeParse({
      operations: 'R("p/c", {name: "x"})',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("embed-only");
    }
  });
});

describe("makeBatchDesignInputSchema({ embedOnly: false }) (default)", () => {
  const schema = makeBatchDesignInputSchema({ embedOnly: false });

  it("still allows native node creation", () => {
    const result = schema.safeParse({
      operations: 'x=I(document, {type: "frame"})',
    });
    expect(result.success).toBe(true);
  });

  it("regression: a 30-operation script validates successfully and passes the operations through unmodified (no backend truncation)", () => {
    const ops = Array.from({ length: 30 }, (_, i) => `D("node${i}")`).join(
      "\n",
    );
    const result = schema.safeParse({ operations: ops });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.operations).toBe(ops);
    }
  });
});
