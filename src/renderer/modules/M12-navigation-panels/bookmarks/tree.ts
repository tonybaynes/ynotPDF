/**
 * Outline (bookmark) tree operations (M12) — pure functions over the model's flat
 * `ModelOutlineItem[]`.
 *
 * The model stores the outline as one array in which **parents come before their children** and
 * `childIds` gives the order of a node's children. Root order is the order the roots appear in
 * the array. Every function here takes a list and returns a new one in that same canonical form
 * (a pre-order walk), so a caller can hand the result straight to `Document.setOutlineRecord`
 * and a command can restore the previous array to undo.
 *
 * Nothing here touches the document, the engine or the DOM: this is where the tree logic is
 * tested, and `commands.ts` is where it is applied.
 */

import type { ModelId } from '@core/Ids';
import type { ModelOutlineItem } from '@core/model';

/** A node plus its depth, in the order a tree renders. */
export interface OutlineRow {
  readonly item: ModelOutlineItem;
  readonly depth: number;
}

/** Roots, in order. */
export function rootsOf(list: ReadonlyArray<ModelOutlineItem>): ModelOutlineItem[] {
  return list.filter((o) => o.parentId === null);
}

/** A node by id, or null. */
export function itemOf(
  list: ReadonlyArray<ModelOutlineItem>,
  id: ModelId,
): ModelOutlineItem | null {
  return list.find((o) => o.id === id) ?? null;
}

/** Children of a node, in `childIds` order, skipping ids the list does not hold. */
export function childrenOf(list: ReadonlyArray<ModelOutlineItem>, id: ModelId): ModelOutlineItem[] {
  const parent = itemOf(list, id);
  if (!parent) return [];
  const byId = new Map(list.map((o) => [o.id, o]));
  return parent.childIds.flatMap((c) => {
    const found = byId.get(c);
    return found ? [found] : [];
  });
}

/** Every node in tree order with its depth (0 for a root). */
export function walk(list: ReadonlyArray<ModelOutlineItem>): OutlineRow[] {
  const byId = new Map(list.map((o) => [o.id, o]));
  const out: OutlineRow[] = [];
  const seen = new Set<string>();
  const visit = (item: ModelOutlineItem, depth: number): void => {
    if (seen.has(item.id) || depth > 64) return;
    seen.add(item.id);
    out.push({ item, depth });
    for (const childId of item.childIds) {
      const child = byId.get(childId);
      if (child) visit(child, depth + 1);
    }
  };
  for (const root of rootsOf(list)) visit(root, 0);
  // A node whose parent is missing would otherwise disappear; show it as a root rather than
  // losing it, which is what a malformed file needs.
  for (const item of list) if (!seen.has(item.id)) visit(item, 0);
  return out;
}

/** Depth of one node, or -1 when it is not in the list. */
export function depthOf(list: ReadonlyArray<ModelOutlineItem>, id: ModelId): number {
  return walk(list).find((r) => r.item.id === id)?.depth ?? -1;
}

/** The greatest depth in the tree (0 for a flat list, -1 for an empty one). */
export function maxDepth(list: ReadonlyArray<ModelOutlineItem>): number {
  return walk(list).reduce((max, r) => Math.max(max, r.depth), list.length === 0 ? -1 : 0);
}

/** A node and everything under it, in tree order. */
export function subtreeOf(list: ReadonlyArray<ModelOutlineItem>, id: ModelId): ModelOutlineItem[] {
  const byId = new Map(list.map((o) => [o.id, o]));
  const out: ModelOutlineItem[] = [];
  const visit = (nodeId: ModelId): void => {
    const node = byId.get(nodeId);
    if (!node || out.some((o) => o.id === nodeId)) return;
    out.push(node);
    for (const childId of node.childIds) visit(childId);
  };
  visit(id);
  return out;
}

/** True when `ancestorId` is `id` or one of its ancestors — the guard a drag needs. */
export function isDescendant(
  list: ReadonlyArray<ModelOutlineItem>,
  id: ModelId,
  ancestorId: ModelId,
): boolean {
  const byId = new Map(list.map((o) => [o.id, o]));
  let current: ModelId | null = id;
  for (let guard = 0; current !== null && guard < 128; guard++) {
    if (current === ancestorId) return true;
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

/**
 * Rebuilds the canonical array from a node map and the root order: a pre-order walk, so parents
 * always precede their children. Unreachable nodes are dropped, which is how a removal works.
 */
function rebuild(
  byId: ReadonlyMap<string, ModelOutlineItem>,
  rootIds: ReadonlyArray<ModelId>,
): ModelOutlineItem[] {
  const out: ModelOutlineItem[] = [];
  const seen = new Set<string>();
  const visit = (id: ModelId): void => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    out.push(node);
    for (const childId of node.childIds) visit(childId);
  };
  for (const id of rootIds) visit(id);
  return out;
}

/** The list as a map plus its root order — the shape every edit below works in. */
function explode(list: ReadonlyArray<ModelOutlineItem>): {
  byId: Map<string, ModelOutlineItem>;
  rootIds: ModelId[];
} {
  return {
    byId: new Map(list.map((o) => [o.id, o])),
    rootIds: rootsOf(list).map((o) => o.id),
  };
}

/** Where a node sits: its parent (null for a root) and its index among its siblings. */
export interface Position {
  readonly parentId: ModelId | null;
  readonly index: number;
}

/** The position of a node, or null when the list does not hold it. */
export function positionOf(list: ReadonlyArray<ModelOutlineItem>, id: ModelId): Position | null {
  const item = itemOf(list, id);
  if (!item) return null;
  if (item.parentId === null) {
    return { parentId: null, index: rootsOf(list).findIndex((o) => o.id === id) };
  }
  const parent = itemOf(list, item.parentId);
  return { parentId: item.parentId, index: parent ? parent.childIds.indexOf(id) : 0 };
}

/** Inserts a node at a position. The node's own `parentId` and `childIds` are set from here. */
export function insert(
  list: ReadonlyArray<ModelOutlineItem>,
  item: ModelOutlineItem,
  at: Position,
): ModelOutlineItem[] {
  const { byId, rootIds } = explode(list);
  const node: ModelOutlineItem = { ...item, parentId: at.parentId };
  byId.set(node.id, node);
  if (at.parentId === null) {
    rootIds.splice(clamp(at.index, rootIds.length), 0, node.id);
  } else {
    const parent = byId.get(at.parentId);
    if (!parent) return [...list];
    const childIds = [...parent.childIds];
    childIds.splice(clamp(at.index, childIds.length), 0, node.id);
    byId.set(parent.id, { ...parent, childIds });
  }
  return rebuild(byId, rootIds);
}

/**
 * Removes a node **and everything under it**. Returns the new list and the removed subtree in
 * tree order, which is exactly what an undo needs to put it back.
 */
export function removeSubtree(
  list: ReadonlyArray<ModelOutlineItem>,
  id: ModelId,
): { list: ModelOutlineItem[]; removed: ModelOutlineItem[]; at: Position } {
  const at = positionOf(list, id) ?? { parentId: null, index: 0 };
  const removed = subtreeOf(list, id);
  if (removed.length === 0) return { list: [...list], removed, at };
  const { byId, rootIds } = explode(list);
  const item = byId.get(id);
  if (item?.parentId != null) {
    const parent = byId.get(item.parentId);
    if (parent) {
      byId.set(parent.id, { ...parent, childIds: parent.childIds.filter((c) => c !== id) });
    }
  }
  for (const node of removed) byId.delete(node.id);
  return {
    list: rebuild(
      byId,
      rootIds.filter((r) => r !== id),
    ),
    removed,
    at,
  };
}

/** Puts a removed subtree back exactly where it was (the undo of {@link removeSubtree}). */
export function restoreSubtree(
  list: ReadonlyArray<ModelOutlineItem>,
  removed: ReadonlyArray<ModelOutlineItem>,
  at: Position,
): ModelOutlineItem[] {
  const root = removed[0];
  if (!root) return [...list];
  const { byId, rootIds } = explode(list);
  for (const node of removed) byId.set(node.id, node);
  if (at.parentId === null) {
    rootIds.splice(clamp(at.index, rootIds.length), 0, root.id);
  } else {
    const parent = byId.get(at.parentId);
    if (!parent) return [...list];
    const childIds = [...parent.childIds];
    childIds.splice(clamp(at.index, childIds.length), 0, root.id);
    byId.set(parent.id, { ...parent, childIds });
  }
  return rebuild(byId, rootIds);
}

/**
 * Moves a node (with its subtree) to a new parent and index. Moving a node inside itself is a
 * no-op — that is the drag the user did not mean.
 */
export function move(
  list: ReadonlyArray<ModelOutlineItem>,
  id: ModelId,
  to: Position,
): ModelOutlineItem[] {
  const item = itemOf(list, id);
  if (!item) return [...list];
  if (to.parentId !== null && isDescendant(list, to.parentId, id)) return [...list];
  const from = positionOf(list, id);
  if (!from) return [...list];
  const { byId, rootIds } = explode(list);

  // Detach.
  if (item.parentId === null) {
    const at = rootIds.indexOf(id);
    if (at >= 0) rootIds.splice(at, 1);
  } else {
    const parent = byId.get(item.parentId);
    if (parent) {
      byId.set(parent.id, { ...parent, childIds: parent.childIds.filter((c) => c !== id) });
    }
  }

  // Re-attach. The index is in the list *after* the removal, which is how a caller thinks about
  // "put it third", so no correction is needed for a move inside the same parent.
  byId.set(id, { ...item, parentId: to.parentId });
  if (to.parentId === null) {
    rootIds.splice(clamp(to.index, rootIds.length), 0, id);
  } else {
    const parent = byId.get(to.parentId);
    if (!parent) return [...list];
    const childIds = [...parent.childIds];
    childIds.splice(clamp(to.index, childIds.length), 0, id);
    byId.set(parent.id, { ...parent, childIds });
  }
  return rebuild(byId, rootIds);
}

/**
 * Makes a node a child of its previous sibling (Foxit's "Indent"). A node with no previous
 * sibling cannot be indented, and the list comes back unchanged.
 */
export function indent(list: ReadonlyArray<ModelOutlineItem>, id: ModelId): ModelOutlineItem[] {
  const at = positionOf(list, id);
  if (!at || at.index === 0) return [...list];
  const siblings = at.parentId === null ? rootsOf(list) : childrenOf(list, at.parentId);
  const previous = siblings[at.index - 1];
  if (!previous) return [...list];
  return move(list, id, { parentId: previous.id, index: previous.childIds.length });
}

/** Makes a node the next sibling of its parent (Foxit's "Outdent"). A root cannot outdent. */
export function outdent(list: ReadonlyArray<ModelOutlineItem>, id: ModelId): ModelOutlineItem[] {
  const item = itemOf(list, id);
  if (!item?.parentId) return [...list];
  const parentPosition = positionOf(list, item.parentId);
  if (!parentPosition) return [...list];
  return move(list, id, {
    parentId: parentPosition.parentId,
    index: parentPosition.index + 1,
  });
}

/** Replaces one node's fields, leaving the shape alone. */
export function update(
  list: ReadonlyArray<ModelOutlineItem>,
  id: ModelId,
  patch: Partial<Omit<ModelOutlineItem, 'id' | 'parentId' | 'childIds'>>,
): ModelOutlineItem[] {
  return list.map((o) => (o.id === id ? { ...o, ...patch } : o));
}

/** Sets `open` on every node down to `level` and closes everything deeper (expand-to-level). */
export function expandToLevel(
  list: ReadonlyArray<ModelOutlineItem>,
  level: number,
): ModelOutlineItem[] {
  const depths = new Map(walk(list).map((r) => [r.item.id, r.depth]));
  return list.map((o) => ({ ...o, open: (depths.get(o.id) ?? 0) < level }));
}

function clamp(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.round(index), length));
}
