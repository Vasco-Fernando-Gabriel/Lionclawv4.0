import type { ArchmapBridge } from "../../bridge/lionclaw-bridge";

export type {
  ArchmapBridge,
  ArchmapBridgeResource,
  BridgeFetchOptions,
  BridgeInit,
  BridgeResponse,
} from "../../bridge/lionclaw-bridge";

let instance: ArchmapBridge | null = null;

export function setBridge(bridge: ArchmapBridge | null): void {
  instance = bridge;
}

export function getBridge(): ArchmapBridge {
  if (!instance) {
    throw new Error("Archmap bridge not installed: call setBridge() before mounting the dashboard");
  }
  return instance;
}
