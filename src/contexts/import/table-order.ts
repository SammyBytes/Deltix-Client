/**
 * Order tables so a parent is imported before any child that references it
 * (FK-safe). Edges are `{ child, parent }`. Unknown/absent nodes are ignored;
 * cycles fall back to the original order so import never deadlocks on messy
 * source schemas.
 */
export function topoOrder(tables: string[], edges: { child: string; parent: string }[]): string[] {
  const present = new Set(tables);
  const indeg = new Map<string, number>();
  const childrenOf = new Map<string, string[]>();
  for (const t of tables) {
    indeg.set(t, 0);
  }
  for (const { child, parent } of edges) {
    if (!present.has(child) || !present.has(parent) || child === parent) {
      continue;
    }
    // parent -> child dependency: child must come after parent.
    indeg.set(child, (indeg.get(child) ?? 0) + 1);
    const list = childrenOf.get(parent) ?? [];
    list.push(child);
    childrenOf.set(parent, list);
  }

  const ordered: string[] = [];
  // Seed with zero-indegree nodes in the caller's original order for stability.
  const queue = tables.filter((t) => (indeg.get(t) ?? 0) === 0);
  while (queue.length > 0) {
    const node = queue.shift() as string;
    ordered.push(node);
    for (const child of childrenOf.get(node) ?? []) {
      const next = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, next);
      if (next === 0) {
        queue.push(child);
      }
    }
  }
  if (ordered.length < tables.length) {
    // Cycle: append the remainder in original order.
    const done = new Set(ordered);
    for (const t of tables) {
      if (!done.has(t)) {
        ordered.push(t);
      }
    }
  }
  return ordered;
}
