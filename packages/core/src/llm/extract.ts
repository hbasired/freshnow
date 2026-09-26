/**
 * Pull a JSON object out of an LLM response, tolerantly: strip markdown code
 * fences, then parse; if that fails, take the outermost {...}. Reasoning models
 * sometimes wrap the JSON in prose, so this keeps the wrapper robust. Throws if
 * no JSON object is present (the caller treats that as a failed parse).
 */
export function extractJson(content: string): unknown {
  let s = content.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    // fall through to brace extraction
  }

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return JSON.parse(s.slice(first, last + 1));
  }
  throw new Error("No JSON object found in model output");
}
