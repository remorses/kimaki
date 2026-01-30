// Snapshot and restore utilities for temporary project modifications

import type { LayerProperties } from "./types";
import { findNodeById } from "./traverse";

export type Snapshot = Record<string, LayerProperties>;

/**
 * Create a snapshot of specific nodes' current state
 * Use this before making temporary changes that you want to restore later
 */
export function createSnapshot(nodeIds: string[]): Snapshot {
  const snapshot: Snapshot = {};

  for (const nodeId of nodeIds) {
    const node = findNodeById(nodeId);
    if (node?.item) {
      // Deep clone the item to avoid reference issues
      snapshot[nodeId] = JSON.parse(JSON.stringify(node.item));
    }
  }

  return snapshot;
}

/**
 * Restore nodes to their previously saved state
 */
export function restoreFromSnapshot(snapshot: Snapshot): void {
  for (const [nodeId, data] of Object.entries(snapshot)) {
    window.app.dispatchAction({
      type: "updateObjWithUndo",
      objId: nodeId,
      data: data,
    });
  }
}

/**
 * Duplicate the current project file
 * Returns the new file's ID
 */
export async function duplicateProject(): Promise<string> {
  const currentFileId = window.app.props.fileMeta.id;
  return await window.app.props.fileActions.duplicateFile(currentFileId);
}

/**
 * Delete a project file by ID
 */
export async function deleteProject(fileId: string): Promise<void> {
  await window.app.props.fileActions.deleteFile(fileId);
}

/**
 * Create a snapshot of all media nodes for easy restoration
 */
export function createMediaSnapshot(): { snapshot: Snapshot; nodeIds: string[] } {
  const conf = window.app.props.observableImmutableConf.lastImmutableConf;
  const nodeIds: string[] = [];
  const mediaTypes = new Set(["svg", "image", "video", "gif"]);

  const collectIds = (node: { id: string; item?: { type: string }; children?: unknown[] }): void => {
    if (node.item && mediaTypes.has(node.item.type)) {
      nodeIds.push(node.id);
    }
    if (node.children) {
      (node.children as typeof node[]).forEach(collectIds);
    }
  };

  (conf.roots || []).forEach(collectIds);

  return {
    snapshot: createSnapshot(nodeIds),
    nodeIds,
  };
}

/**
 * Create a snapshot of all text nodes for easy restoration
 */
export function createTextSnapshot(): { snapshot: Snapshot; nodeIds: string[] } {
  const conf = window.app.props.observableImmutableConf.lastImmutableConf;
  const nodeIds: string[] = [];

  const collectIds = (node: { id: string; item?: { type: string }; children?: unknown[] }): void => {
    if (node.item?.type === "text") {
      nodeIds.push(node.id);
    }
    if (node.children) {
      (node.children as typeof node[]).forEach(collectIds);
    }
  };

  (conf.roots || []).forEach(collectIds);

  return {
    snapshot: createSnapshot(nodeIds),
    nodeIds,
  };
}

export interface ExportWithRestoreOptions {
  replacements: Array<{ nodeId: string; data: Record<string, unknown> }>;
  onBeforeExport?: () => void | Promise<void>;
}

/**
 * Apply temporary changes, run a callback, then restore original state
 * Useful for exporting with temporary asset replacements
 */
export async function withTemporaryChanges<T>(
  nodeIds: string[],
  changes: Record<string, Record<string, unknown>>,
  callback: () => T | Promise<T>
): Promise<T> {
  // Create snapshot before changes
  const snapshot = createSnapshot(nodeIds);

  try {
    // Apply changes
    for (const [nodeId, data] of Object.entries(changes)) {
      window.app.dispatchAction({
        type: "updateObjWithUndo",
        objId: nodeId,
        data: data,
      });
    }

    // Wait for changes to sync
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Run callback
    return await callback();
  } finally {
    // Always restore original state
    restoreFromSnapshot(snapshot);
  }
}
