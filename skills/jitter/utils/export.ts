// Export URL generation utilities

import type { ExportProfile } from "./types";
import { getArtboards } from "./traverse";

export interface ExportUrlOptions {
  fileId: string;
  artboardId: string;
  width: number;
  height: number;
  profile?: ExportProfile;
}

/**
 * Generate a Jitter export URL for downloading Lottie/video/etc
 */
export function generateExportUrl(options: ExportUrlOptions): string {
  const { fileId, artboardId, width, height, profile = "lottie" } = options;
  const params = new URLSearchParams({
    file: fileId,
    artboardId: artboardId,
    profile: profile,
    width: width.toString(),
    height: height.toString(),
  });
  return `https://jitter.video/export/?${params.toString()}`;
}

export interface CurrentProjectExportOptions {
  artboardName?: string;
  profile?: ExportProfile;
}

/**
 * Generate export URL from the currently open project
 */
export function generateExportUrlFromCurrentProject(
  options: CurrentProjectExportOptions = {}
): string {
  const { artboardName, profile = "lottie" } = options;
  const fileId = window.app.props.fileMeta.id;
  const artboards = getArtboards();

  const artboard = artboardName
    ? artboards.find((a) => a.name === artboardName)
    : artboards[0];

  if (!artboard) {
    throw new Error(
      artboardName
        ? `Artboard "${artboardName}" not found`
        : "No artboard found in project"
    );
  }

  return generateExportUrl({
    fileId,
    artboardId: artboard.id,
    width: artboard.width,
    height: artboard.height,
    profile,
  });
}

export interface ParsedJitterUrl {
  fileId: string | null;
  nodeId: string | null;
}

/**
 * Parse a Jitter project URL to extract file and node IDs
 */
export function parseJitterUrl(url: string): ParsedJitterUrl {
  const parsed = new URL(url);
  return {
    fileId: parsed.searchParams.get("id"),
    nodeId: parsed.searchParams.get("nodeId"),
  };
}

/**
 * Get the current project's file metadata
 */
export function getFileMeta(): { id: string; name: string; bucket: string; teamId?: string } {
  return window.app.props.fileMeta;
}

/**
 * Generate a URL to open a specific node in the editor
 */
export function generateNodeUrl(fileId: string, nodeId: string): string {
  const params = new URLSearchParams({
    id: fileId,
    nodeId: nodeId,
  });
  return `https://jitter.video/file/?${params.toString()}`;
}

/**
 * Get URL for the currently open project
 */
export function getCurrentProjectUrl(nodeId?: string): string {
  const fileId = window.app.props.fileMeta.id;
  const params = new URLSearchParams({ id: fileId });
  if (nodeId) {
    params.set("nodeId", nodeId);
  }
  return `https://jitter.video/file/?${params.toString()}`;
}
