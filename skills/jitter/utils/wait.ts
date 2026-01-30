// Waiting utilities for Jitter app initialization and sync

import type { JitterApp } from "./types";

/**
 * Wait for the Jitter app to be fully loaded and ready
 * Call this after navigating to a project URL
 */
export function waitForApp(timeoutMs = 30000): Promise<JitterApp> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = (): void => {
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error("Timeout waiting for Jitter app to load"));
        return;
      }

      const app = window.app;
      if (app?.props?.observableImmutableConf?.lastImmutableConf) {
        resolve(app);
      } else {
        setTimeout(check, 100);
      }
    };

    check();
  });
}

/**
 * Wait for changes to sync to the server
 * Call this after making modifications before exporting
 */
export function waitForSync(delayMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Wait for a specific condition to be true
 */
export function waitFor(
  condition: () => boolean,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 30000, interval = 100 } = options;

  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = (): void => {
      if (Date.now() - startTime > timeout) {
        reject(new Error("Timeout waiting for condition"));
        return;
      }

      if (condition()) {
        resolve();
      } else {
        setTimeout(check, interval);
      }
    };

    check();
  });
}

/**
 * Wait for a specific node to exist in the project
 */
export function waitForNode(nodeId: string, timeoutMs = 10000): Promise<void> {
  return waitFor(
    () => {
      const conf = window.app?.props?.observableImmutableConf?.lastImmutableConf;
      if (!conf) {
        return false;
      }

      const search = (node: { id: string; children?: unknown[] }): boolean => {
        if (node.id === nodeId) {
          return true;
        }
        if (node.children) {
          return (node.children as typeof node[]).some(search);
        }
        return false;
      };

      return (conf.roots || []).some(search);
    },
    { timeout: timeoutMs }
  );
}

/**
 * Wait for the project configuration to change
 * Useful after making updates to detect when they've been applied
 */
export function waitForConfigChange(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timeout waiting for config change"));
    }, timeoutMs);

    const unsubscribe = window.app.props.observableImmutableConf.subscribe(() => {
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

/**
 * Check if the app is currently in read-only mode
 */
export function isReadOnly(): boolean {
  return window.app?.isReadOnly?.() ?? false;
}

/**
 * Check if the app is ready for interaction
 */
export function isAppReady(): boolean {
  return !!(
    window.app?.props?.observableImmutableConf?.lastImmutableConf &&
    window.app?.props?.fileMeta?.id
  );
}
