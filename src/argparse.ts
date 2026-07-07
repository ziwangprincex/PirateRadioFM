// Pure-function CLI argv parser. Extracted so selfcheck can exercise its edge
// cases (multi-word values, schema-aware number coercion, JSON-blob mode)
// without importing cli.ts, which pulls in tools/state and their side effects.
//
// Given the argv tail after the tool name and the tool's JSON schema, return
// the args object to pass to the handler.
//   1. Single JSON blob:  ['{"genre":"jazz"}']  →  { genre: "jazz" }
//   2. key=value pairs:   ['genre=jazz']         →  { genre: "jazz" }
//   3. Multi-word values: ['target=my','list']   →  { target: "my list" }
//      (shells split on whitespace; barewords fold into the previous key.)

export function parseArgs(rest: string[], schema: any): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (rest.length === 1 && rest[0].startsWith("{")) {
    return JSON.parse(rest[0]);
  }
  const schemaProps: Record<string, { type?: string }> = (schema && schema.properties) || {};
  let lastKey: string | null = null;
  for (const kv of rest) {
    const eq = kv.indexOf("=");
    if (eq === -1) {
      if (lastKey !== null && typeof args[lastKey] === "string") {
        args[lastKey] = `${args[lastKey]} ${kv}`;
      }
      continue;
    }
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    const expected = schemaProps[k]?.type;
    // Only coerce when the schema explicitly declares a number. Otherwise a
    // hypothetical `genre=80` or `target=1234` would silently become a Number
    // and no longer match by string equality against playlist / genre names.
    if ((expected === "number" || expected === "integer") && /^-?\d+(\.\d+)?$/.test(v)) {
      args[k] = Number(v);
      lastKey = null; // numbers can't be extended by more tokens
    } else {
      args[k] = v;
      lastKey = k;
    }
  }
  return args;
}
