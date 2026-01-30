// Action helpers for modifying Jitter projects

import type { LayerProperties } from "./types";

function dispatch(action: Record<string, unknown>): void {
  window.app.dispatchAction(action);
}

/**
 * Replace the URL of an asset node (image, SVG, video)
 */
export function replaceAssetUrl(nodeId: string, newUrl: string): void {
  dispatch({
    type: "updateObjWithUndo",
    objId: nodeId,
    data: { url: newUrl },
  });
}

/**
 * Replace text content of a text node
 */
export function replaceText(nodeId: string, newText: string): void {
  dispatch({
    type: "updateObjWithUndo",
    objId: nodeId,
    data: { text: newText },
  });
}

/**
 * Update multiple properties on a node
 */
export function updateNode(
  nodeId: string,
  properties: Partial<LayerProperties> & { url?: string; text?: string }
): void {
  dispatch({
    type: "updateObjWithUndo",
    objId: nodeId,
    data: properties,
  });
}

export interface ReplacementItem {
  nodeId: string;
  data: Partial<LayerProperties> & { url?: string; text?: string };
}

/**
 * Batch update multiple nodes at once
 */
export function batchReplace(replacements: ReplacementItem[]): void {
  for (const { nodeId, data } of replacements) {
    dispatch({
      type: "updateObjWithUndo",
      objId: nodeId,
      data: data,
    });
  }
}

/**
 * Select specific nodes by their IDs
 */
export function selectNodes(nodeIds: string[]): void {
  dispatch({
    type: "setSelection",
    selection: { nodesIds: nodeIds },
    saveInCmdHistory: true,
  });
}

/**
 * Clear the current selection
 */
export function clearSelection(): void {
  dispatch({ type: "emptySelection" });
}

/**
 * Delete the currently selected nodes
 */
export function deleteSelection(): void {
  dispatch({ type: "deleteCurrentSelection" });
}

/**
 * Remove specific nodes by their IDs
 */
export function removeNodes(nodeIds: string[]): void {
  dispatch({
    type: "removeObjWithUndo",
    objIds: nodeIds,
  });
}

/**
 * Undo the last action
 */
export function undo(): void {
  dispatch({ type: "undo" });
}

/**
 * Redo the last undone action
 */
export function redo(): void {
  dispatch({ type: "redo" });
}

/**
 * Rename a node
 */
export function renameNode(nodeId: string, newName: string): void {
  selectNodes([nodeId]);
  dispatch({
    type: "renameSelection",
    name: newName,
  });
}

/**
 * Update node position
 */
export function moveNode(nodeId: string, x: number, y: number): void {
  dispatch({
    type: "updateObjWithUndo",
    objId: nodeId,
    data: { x, y },
  });
}

/**
 * Update node size
 */
export function resizeNode(nodeId: string, width: number, height: number): void {
  dispatch({
    type: "updateObjWithUndo",
    objId: nodeId,
    data: { width, height },
  });
}

/**
 * Update node opacity (0-100)
 */
export function setOpacity(nodeId: string, opacity: number): void {
  dispatch({
    type: "updateObjWithUndo",
    objId: nodeId,
    data: { opacity },
  });
}

/**
 * Update node rotation angle in degrees
 */
export function setRotation(nodeId: string, angle: number): void {
  dispatch({
    type: "updateObjWithUndo",
    objId: nodeId,
    data: { angle },
  });
}

/**
 * Set the current playhead time for an artboard
 */
export function setCurrentTime(artboardId: string, timeMs: number): void {
  dispatch({
    type: "setArtboardsTime",
    times: { [artboardId]: timeMs },
  });
}

/**
 * Jump playhead to start
 */
export function jumpToStart(): void {
  dispatch({ type: "jumpToStartTime" });
}

/**
 * Jump playhead to end
 */
export function jumpToEnd(): void {
  dispatch({ type: "jumpToEndTime" });
}

/**
 * Add a new object to the project
 */
export function addObject(
  parentId: string,
  id: string,
  item: LayerProperties,
  index?: string
): void {
  dispatch({ type: "saveSelectionForUndo" });
  dispatch({
    type: "addObjWithUndo",
    parentId,
    objData: { id, item },
    index,
  });
  selectNodes([id]);
}
