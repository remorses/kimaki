// Jitter type definitions extracted from the editor API

export type LayerType =
  | "artboard"
  | "text"
  | "image"
  | "svg"
  | "video"
  | "gif"
  | "rect"
  | "ellipse"
  | "star"
  | "layerGrp";

export type ExportProfile =
  | "lottie"
  | "mp4"
  | "gif"
  | "webm"
  | "prores4444"
  | "pngs";

export interface JitterFont {
  name: string;
  type: "googlefont" | "system" | "custom";
  weight: number;
}

export interface GradientStop {
  id: string;
  position: number;
  color: string;
}

export interface GradientTransform {
  angle?: number;
  sx: number;
  tx: number;
  ty: number;
}

export interface Gradient {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL";
  stops: GradientStop[];
  transform: GradientTransform;
}

export type FillColor = string | Gradient;

export interface BaseLayerProperties {
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  scale?: number;
  opacity?: number;
  shadowEnabled?: boolean;
  strokeEnabled?: boolean;
}

export interface ArtboardProperties extends BaseLayerProperties {
  type: "artboard";
  background?: boolean;
  fillColor?: FillColor;
  duration?: number;
}

export interface TextProperties extends BaseLayerProperties {
  type: "text";
  text: string;
  font?: JitterFont;
  fontSize?: number;
  fillColor?: FillColor;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  lineHeight?: number;
  letterSpacing?: number;
  kerning?: boolean;
  ligatures?: boolean;
  case?: "normal" | "upper" | "lower";
  dir?: "ltr" | "rtl";
  autoResize?: "none" | "height" | "width";
}

export interface ImageProperties extends BaseLayerProperties {
  type: "image";
  url: string;
  mediaName?: string;
  cornerRadius?: number;
}

export interface SvgProperties extends BaseLayerProperties {
  type: "svg";
  url: string;
  mediaName?: string;
  cornerRadius?: number;
}

export interface VideoProperties extends BaseLayerProperties {
  type: "video";
  url: string;
  mediaName?: string;
  audioUrl?: string | null;
  cornerRadius?: number;
}

export interface GifProperties extends BaseLayerProperties {
  type: "gif";
  url: string;
  mediaName?: string;
  cornerRadius?: number;
}

export interface RectProperties extends BaseLayerProperties {
  type: "rect";
  fillColor?: FillColor;
  cornerRadius?: number;
  strokeColor?: string;
  strokeWidth?: number;
}

export interface EllipseProperties extends BaseLayerProperties {
  type: "ellipse";
  fillColor?: FillColor;
}

export interface StarProperties extends BaseLayerProperties {
  type: "star";
  fillColor?: FillColor;
  points?: number;
  innerRadius?: number;
}

export interface LayerGrpProperties extends BaseLayerProperties {
  type: "layerGrp";
  clipsContent?: boolean;
  background?: boolean;
  cornerRadius?: number;
}

export type LayerProperties =
  | ArtboardProperties
  | TextProperties
  | ImageProperties
  | SvgProperties
  | VideoProperties
  | GifProperties
  | RectProperties
  | EllipseProperties
  | StarProperties
  | LayerGrpProperties;

export interface JitterNode {
  id: string;
  item: LayerProperties;
  position?: {
    parentId: string;
    index: string;
  };
  children?: JitterNode[];
}

export interface JitterConf {
  roots: JitterNode[];
}

export interface FileMeta {
  id: string;
  name: string;
  bucket: string;
  teamId?: string;
}

export interface EasingConfig {
  name: string;
  schema: string;
  config: Record<string, number>;
}

export interface AnimationOperation {
  type: string;
  targetId: string;
  startTime: number;
  endTime: number;
  fromValue?: number | { x: number; y: number };
  toValue?: number | { x: number; y: number };
  easing?: EasingConfig;
}

// Action types for dispatchAction
export interface UpdateAction {
  type: "updateObjWithUndo";
  objId: string;
  data: Partial<LayerProperties> & { url?: string; text?: string };
}

export interface AddAction {
  type: "addObjWithUndo";
  parentId: string;
  objData: {
    id: string;
    item: LayerProperties;
  };
  index?: string;
}

export interface RemoveAction {
  type: "removeObjWithUndo";
  objIds: string[];
}

export interface SetSelectionAction {
  type: "setSelection";
  selection: {
    nodesIds: string[];
  };
  saveInCmdHistory?: boolean;
}

export type JitterAction =
  | UpdateAction
  | AddAction
  | RemoveAction
  | SetSelectionAction
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saveSelectionForUndo" }
  | { type: "emptySelection" }
  | { type: "deleteCurrentSelection" };

// Jitter app interface (available as window.app)
export interface JitterApp {
  props: {
    fileMeta: FileMeta;
    observableImmutableConf: {
      lastImmutableConf: JitterConf;
      subscribe: (callback: () => void) => () => void;
    };
    observableEditorState: {
      getSnapshot: () => {
        selection: { nodesIds: string[] };
        base: { artboardTimes: Record<string, number> };
        toolbox: { currentMode: { mode: { name: string } } };
      };
    };
    rendererRuntime: {
      getAssetStore: () => Map<string, unknown>;
    };
    fileActions: {
      duplicateFile: (fileId: string) => Promise<string>;
      deleteFile: (fileId: string) => Promise<void>;
      renameFile: (name: string) => Promise<void>;
      saveFile: () => Promise<void>;
    };
  };
  dispatchAction: (action: JitterAction | Record<string, unknown>) => void;
  addArtboard: () => void;
  addText: (source: "toolbar" | "keyboard") => void;
  addRectShape: (source: string) => void;
  addEllipseShape: (source: string) => void;
  addMedia: (source: string) => void;
  play: () => void;
  stopPlayback: () => void;
  moveCursor: (timeInMs: number) => void;
  renameFile: (name: string) => void;
  deleteFile: () => void;
  downloadProject: () => void;
  scheduleSave: () => void;
  getState: () => unknown;
  isReadOnly: () => boolean;
}

declare global {
  interface Window {
    app: JitterApp;
  }
}
