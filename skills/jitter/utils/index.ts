// Jitter Utils - Bundle entry point
// Exports all utilities and attaches to globalThis.jitterUtils

export * from "./types";
export * from "./traverse";
export * from "./actions";
export * from "./export";
export * from "./snapshot";
export * from "./wait";

// Re-export specific functions for easier access
import {
  findNodeById,
  findAllMediaNodes,
  findAllTextNodes,
  getArtboards,
  findNodesByType,
  findNodesByName,
  getParentNode,
  getAncestors,
  flattenTree,
} from "./traverse";

import {
  replaceAssetUrl,
  replaceText,
  updateNode,
  batchReplace,
  selectNodes,
  clearSelection,
  deleteSelection,
  removeNodes,
  undo,
  redo,
  renameNode,
  moveNode,
  resizeNode,
  setOpacity,
  setRotation,
  setCurrentTime,
  jumpToStart,
  jumpToEnd,
  addObject,
} from "./actions";

import {
  generateExportUrl,
  generateExportUrlFromCurrentProject,
  parseJitterUrl,
  getFileMeta,
  generateNodeUrl,
  getCurrentProjectUrl,
} from "./export";

import {
  createSnapshot,
  restoreFromSnapshot,
  duplicateProject,
  deleteProject,
  createMediaSnapshot,
  createTextSnapshot,
  withTemporaryChanges,
} from "./snapshot";

import {
  waitForApp,
  waitForSync,
  waitFor,
  waitForNode,
  waitForConfigChange,
  isReadOnly,
  isAppReady,
} from "./wait";

const jitterUtils = {
  // Traverse
  findNodeById,
  findAllMediaNodes,
  findAllTextNodes,
  getArtboards,
  findNodesByType,
  findNodesByName,
  getParentNode,
  getAncestors,
  flattenTree,

  // Actions
  replaceAssetUrl,
  replaceText,
  updateNode,
  batchReplace,
  selectNodes,
  clearSelection,
  deleteSelection,
  removeNodes,
  undo,
  redo,
  renameNode,
  moveNode,
  resizeNode,
  setOpacity,
  setRotation,
  setCurrentTime,
  jumpToStart,
  jumpToEnd,
  addObject,

  // Export
  generateExportUrl,
  generateExportUrlFromCurrentProject,
  parseJitterUrl,
  getFileMeta,
  generateNodeUrl,
  getCurrentProjectUrl,

  // Snapshot
  createSnapshot,
  restoreFromSnapshot,
  duplicateProject,
  deleteProject,
  createMediaSnapshot,
  createTextSnapshot,
  withTemporaryChanges,

  // Wait
  waitForApp,
  waitForSync,
  waitFor,
  waitForNode,
  waitForConfigChange,
  isReadOnly,
  isAppReady,
};

// Attach to globalThis for browser access
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as { jitterUtils: typeof jitterUtils }).jitterUtils = jitterUtils;
}

export default jitterUtils;
