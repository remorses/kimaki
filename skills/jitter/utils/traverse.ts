// Tree traversal utilities for Jitter project structure

import type { JitterNode, JitterConf, LayerType } from "./types";

function getConf(): JitterConf {
  return window.app.props.observableImmutableConf.lastImmutableConf;
}

/**
 * Find a node by its ID anywhere in the project tree
 */
export function findNodeById(nodeId: string): JitterNode | null {
  const conf = getConf();

  const search = (node: JitterNode): JitterNode | null => {
    if (node.id === nodeId) {
      return node;
    }
    if (node.children) {
      for (const child of node.children) {
        const found = search(child);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };

  for (const root of conf.roots || []) {
    const found = search(root);
    if (found) {
      return found;
    }
  }
  return null;
}

export interface MediaNodeInfo {
  id: string;
  name: string | undefined;
  type: "svg" | "image" | "video" | "gif";
  url: string;
  width: number | undefined;
  height: number | undefined;
}

/**
 * Find all media nodes (images, SVGs, videos, GIFs) in the project
 */
export function findAllMediaNodes(): MediaNodeInfo[] {
  const conf = getConf();
  const mediaNodes: MediaNodeInfo[] = [];
  const mediaTypes = new Set(["svg", "image", "video", "gif"]);

  const search = (node: JitterNode): void => {
    if (node.item && mediaTypes.has(node.item.type)) {
      const item = node.item as { type: "svg" | "image" | "video" | "gif"; url: string; name?: string; width?: number; height?: number };
      mediaNodes.push({
        id: node.id,
        name: item.name,
        type: item.type,
        url: item.url,
        width: item.width,
        height: item.height,
      });
    }
    if (node.children) {
      node.children.forEach(search);
    }
  };

  (conf.roots || []).forEach(search);
  return mediaNodes;
}

export interface TextNodeInfo {
  id: string;
  name: string | undefined;
  text: string;
  fontSize: number | undefined;
  fontFamily: string | undefined;
}

/**
 * Find all text nodes in the project
 */
export function findAllTextNodes(): TextNodeInfo[] {
  const conf = getConf();
  const textNodes: TextNodeInfo[] = [];

  const search = (node: JitterNode): void => {
    if (node.item?.type === "text") {
      const item = node.item as { type: "text"; text: string; name?: string; fontSize?: number; font?: { name: string } };
      textNodes.push({
        id: node.id,
        name: item.name,
        text: item.text,
        fontSize: item.fontSize,
        fontFamily: item.font?.name,
      });
    }
    if (node.children) {
      node.children.forEach(search);
    }
  };

  (conf.roots || []).forEach(search);
  return textNodes;
}

export interface ArtboardInfo {
  id: string;
  name: string | undefined;
  width: number;
  height: number;
  duration: number | undefined;
}

/**
 * Get all artboards in the project
 */
export function getArtboards(): ArtboardInfo[] {
  const conf = getConf();
  return conf.roots
    .filter((r) => r.item?.type === "artboard")
    .map((r) => {
      const item = r.item as { type: "artboard"; name?: string; width: number; height: number; duration?: number };
      return {
        id: r.id,
        name: item.name,
        width: item.width,
        height: item.height,
        duration: item.duration,
      };
    });
}

/**
 * Find all nodes of a specific type
 */
export function findNodesByType(type: LayerType): JitterNode[] {
  const conf = getConf();
  const nodes: JitterNode[] = [];

  const search = (node: JitterNode): void => {
    if (node.item?.type === type) {
      nodes.push(node);
    }
    if (node.children) {
      node.children.forEach(search);
    }
  };

  (conf.roots || []).forEach(search);
  return nodes;
}

/**
 * Find nodes by name (partial match, case-insensitive)
 */
export function findNodesByName(name: string): JitterNode[] {
  const conf = getConf();
  const nodes: JitterNode[] = [];
  const lowerName = name.toLowerCase();

  const search = (node: JitterNode): void => {
    const nodeName = (node.item as { name?: string })?.name;
    if (nodeName && nodeName.toLowerCase().includes(lowerName)) {
      nodes.push(node);
    }
    if (node.children) {
      node.children.forEach(search);
    }
  };

  (conf.roots || []).forEach(search);
  return nodes;
}

/**
 * Get the parent node of a given node
 */
export function getParentNode(nodeId: string): JitterNode | null {
  const node = findNodeById(nodeId);
  if (!node?.position?.parentId) {
    return null;
  }
  return findNodeById(node.position.parentId);
}

/**
 * Get all ancestor nodes from a node up to the root
 */
export function getAncestors(nodeId: string): JitterNode[] {
  const ancestors: JitterNode[] = [];
  let current = findNodeById(nodeId);

  while (current?.position?.parentId) {
    const parent = findNodeById(current.position.parentId);
    if (parent) {
      ancestors.push(parent);
      current = parent;
    } else {
      break;
    }
  }

  return ancestors;
}

/**
 * Flatten the entire node tree into a single array
 */
export function flattenTree(): JitterNode[] {
  const conf = getConf();
  const nodes: JitterNode[] = [];

  const collect = (node: JitterNode): void => {
    nodes.push(node);
    if (node.children) {
      node.children.forEach(collect);
    }
  };

  (conf.roots || []).forEach(collect);
  return nodes;
}
