import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import { useI18n } from "../contexts/I18nContext";
import { LAYER_CLUSTER_WIDTH, LAYER_CLUSTER_HEIGHT } from "../utils/layout";
import { getLayerColor } from "./LayerLegend";

const complexityColors: Record<string, string> = {
  simple: "text-node-function",
  moderate: "text-gold-dim",
  complex: "text-[#c97070]",
};

export interface LayerClusterData extends Record<string, unknown> {
  layerId: string;
  layerName: string;
  layerDescription: string;
  fileCount: number;
  aggregateComplexity: string;
  layerColorIndex: number;
  searchMatchCount?: number;
  onDrillIn: (layerId: string) => void;
}

export type LayerClusterFlowNode = Node<LayerClusterData, "layer-cluster">;

function LayerClusterNode({
  data,
}: NodeProps<LayerClusterFlowNode>) {
  const { t } = useI18n();
  const complexity = t.projectOverview[data.aggregateComplexity as "simple" | "moderate" | "complex"] ?? data.aggregateComplexity;
  const color = getLayerColor(data.layerColorIndex);
  const complexityColor =
    complexityColors[data.aggregateComplexity] ?? complexityColors.simple;

  return (
    <div
      className="architecture-card relative rounded-xl overflow-hidden cursor-pointer transition-[border-color,box-shadow] duration-200 group"
      style={{
        width: LAYER_CLUSTER_WIDTH,
        height: LAYER_CLUSTER_HEIGHT,
      }}
      onClick={() => data.onDrillIn(data.layerId)}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-xl"
        style={{ backgroundColor: color.label }}
      />

      <Handle
        type="target"
        position={Position.Top}
        className="!bg-text-muted !w-2 !h-2"
      />

      <div className="pl-5 pr-4 py-4 h-full flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <span
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: color.label }}
          >
            {t.layer.defaultName}
          </span>
          <div className="flex items-center gap-2">
            {data.searchMatchCount != null && data.searchMatchCount > 0 && (
              <span className="text-[11px] font-mono bg-gold/20 text-gold px-1.5 py-0.5 rounded">
                {data.searchMatchCount} {t.search.result}{data.searchMatchCount !== 1 ? "s" : ""}
              </span>
            )}
            <span className={`text-[11px] font-mono ${complexityColor}`}>
              {complexity}
            </span>
          </div>
        </div>

        <div className="architecture-card-title text-[20px] leading-6 font-semibold line-clamp-2 mb-2" title={data.layerName}>
          {data.layerName}
        </div>

        <div className="architecture-card-summary text-[14px] line-clamp-2 leading-5 mb-3" title={data.layerDescription}>
          {data.layerDescription}
        </div>

        <div className="flex items-center justify-between mt-auto pt-2 border-t border-border-medium">
          <span className="architecture-card-summary text-[12px]">
            {data.fileCount} {t.common.file.toLowerCase()}{data.fileCount !== 1 ? "s" : ""}
          </span>
          <span className="text-[12px] text-accent font-medium">
            {t.layerCluster.explore}
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-text-muted !w-2 !h-2"
      />
    </div>
  );
}

export default memo(LayerClusterNode);
