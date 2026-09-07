/**
 * Icons (M02). Lucide (ISC) icon nodes are imported by name so Vite tree-shakes the ~2000-icon
 * package down to the ones the shell and the built-in modules use; a module that needs another
 * icon registers it with {@link registerIcon}. Every icon renders inline as `<svg>` with
 * `stroke="currentColor"`, so contrast comes from the theme's `--icon` token, never from the
 * icon.
 *
 * An unknown name never renders nothing: it renders a labelled placeholder glyph (a dashed box
 * with the first letter of the label) so a missing icon is visible in review rather than silent.
 */

import {
  FolderOpen,
  History,
  X,
  Undo2,
  Redo2,
  Terminal,
  Info,
  Power,
  Bug,
  Cpu,
  Palette,
  Moon,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Ruler,
  File,
  FilePlus,
  Save,
  Printer,
  Settings,
  LogOut,
  Pin,
  PinOff,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  Check,
  PanelLeft,
  PanelRight,
  PanelLeftClose,
  PanelRightClose,
  BookOpen,
  Columns2,
  Square,
  Rows2,
  Rows3,
  Maximize,
  Minimize,
  Search,
  TriangleAlert,
  CircleAlert,
  CircleCheck,
  CircleX,
  Layers,
  Bookmark,
  Paperclip,
  Image,
  List,
  Menu,
  Ellipsis,
  Plus,
  Minus,
  Trash2,
  ExternalLink,
  Folder,
  GripVertical,
  Keyboard,
  MousePointer,
  Hand,
  PenTool,
  Pencil,
  Highlighter,
  Type,
  SquarePen,
  Eraser,
  PaintBucket,
  Droplet,
  Circle,
  Triangle,
  Star,
  TextCursorInput,
  SlidersHorizontal,
  AppWindow,
  Copy,
  Clipboard,
  Scissors,
  Wrench,
  Shield,
  Lock,
  FileText,
  Files,
  Grid2x2,
  Move,
  ArrowLeft,
  ArrowRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronFirst,
  ChevronLast,
  CircleHelp,
  Sun,
  Contrast,
  Eye,
  EyeOff,
  RefreshCw,
  Download,
  Upload,
  Tag,
  MessageSquare,
  Stamp,
  Signature,
  Link,
  Fullscreen,
  Expand,
  Shrink,
  Monitor,
  SquareCheck,
  Sparkles,
  GalleryVertical,
  GalleryHorizontal,
  FileSearch,
  FileX,
  Book,
  Columns3,
  RectangleHorizontal,
  RectangleVertical,
  PanelTop,
  LayoutGrid,
  Loader,
  CircleDashed,
  OctagonAlert,
  OctagonX,
  Bell,
  Mail,
  User,
  Home,
  Settings2,
  FileCog,
  FileInput,
  FileOutput,
  Import,
  ListTree,
  SquareDashed,
  Pipette,
  Baseline,
} from 'lucide';

/** Lucide's icon shape: `[tag, attributes][]`. */
export type IconNode = ReadonlyArray<
  readonly [string, Readonly<Record<string, string | number | undefined>>]
>;

const ICONS = new Map<string, IconNode>(
  Object.entries({
    'folder-open': FolderOpen,
    history: History,
    x: X,
    'undo-2': Undo2,
    'redo-2': Redo2,
    terminal: Terminal,
    info: Info,
    power: Power,
    bug: Bug,
    cpu: Cpu,
    palette: Palette,
    moon: Moon,
    'zoom-in': ZoomIn,
    'zoom-out': ZoomOut,
    'rotate-ccw': RotateCcw,
    ruler: Ruler,
    file: File,
    'file-plus': FilePlus,
    save: Save,
    printer: Printer,
    settings: Settings,
    'log-out': LogOut,
    pin: Pin,
    'pin-off': PinOff,
    'chevron-down': ChevronDown,
    'chevron-right': ChevronRight,
    'chevron-left': ChevronLeft,
    'chevron-up': ChevronUp,
    check: Check,
    'panel-left': PanelLeft,
    'panel-right': PanelRight,
    'panel-left-close': PanelLeftClose,
    'panel-right-close': PanelRightClose,
    'book-open': BookOpen,
    'columns-2': Columns2,
    square: Square,
    'rows-2': Rows2,
    'rows-3': Rows3,
    maximize: Maximize,
    minimize: Minimize,
    search: Search,
    'triangle-alert': TriangleAlert,
    'circle-alert': CircleAlert,
    'circle-check': CircleCheck,
    'circle-x': CircleX,
    layers: Layers,
    bookmark: Bookmark,
    paperclip: Paperclip,
    image: Image,
    list: List,
    menu: Menu,
    ellipsis: Ellipsis,
    plus: Plus,
    minus: Minus,
    'trash-2': Trash2,
    'external-link': ExternalLink,
    folder: Folder,
    'grip-vertical': GripVertical,
    keyboard: Keyboard,
    'mouse-pointer': MousePointer,
    hand: Hand,
    'pen-tool': PenTool,
    pencil: Pencil,
    highlighter: Highlighter,
    type: Type,
    'square-pen': SquarePen,
    eraser: Eraser,
    'paint-bucket': PaintBucket,
    droplet: Droplet,
    circle: Circle,
    triangle: Triangle,
    star: Star,
    'text-cursor-input': TextCursorInput,
    'sliders-horizontal': SlidersHorizontal,
    'app-window': AppWindow,
    copy: Copy,
    clipboard: Clipboard,
    scissors: Scissors,
    wrench: Wrench,
    shield: Shield,
    lock: Lock,
    'file-text': FileText,
    files: Files,
    'grid-2x2': Grid2x2,
    move: Move,
    'arrow-left': ArrowLeft,
    'arrow-right': ArrowRight,
    'chevrons-left': ChevronsLeft,
    'chevrons-right': ChevronsRight,
    'chevron-first': ChevronFirst,
    'chevron-last': ChevronLast,
    'circle-help': CircleHelp,
    sun: Sun,
    contrast: Contrast,
    eye: Eye,
    'eye-off': EyeOff,
    'refresh-cw': RefreshCw,
    download: Download,
    upload: Upload,
    tag: Tag,
    'message-square': MessageSquare,
    stamp: Stamp,
    signature: Signature,
    link: Link,
    fullscreen: Fullscreen,
    expand: Expand,
    shrink: Shrink,
    monitor: Monitor,
    'square-check': SquareCheck,
    sparkles: Sparkles,
    'gallery-vertical': GalleryVertical,
    'gallery-horizontal': GalleryHorizontal,
    'file-search': FileSearch,
    'file-x': FileX,
    book: Book,
    'columns-3': Columns3,
    'rectangle-horizontal': RectangleHorizontal,
    'rectangle-vertical': RectangleVertical,
    'panel-top': PanelTop,
    'layout-grid': LayoutGrid,
    loader: Loader,
    'circle-dashed': CircleDashed,
    'octagon-alert': OctagonAlert,
    'octagon-x': OctagonX,
    bell: Bell,
    mail: Mail,
    user: User,
    home: Home,
    'settings-2': Settings2,
    'file-cog': FileCog,
    'file-input': FileInput,
    'file-output': FileOutput,
    import: Import,
    'list-tree': ListTree,
    'square-dashed': SquareDashed,
    pipette: Pipette,
    baseline: Baseline,
  }),
);

/** Registers (or overrides) an icon by kebab-case name. */
export function registerIcon(name: string, node: IconNode): void {
  ICONS.set(name, node);
}

export function hasIcon(name: string): boolean {
  return ICONS.has(name);
}

/** All registered names (the demo module lists them). */
export function iconNames(): string[] {
  return Array.from(ICONS.keys()).sort();
}

export interface IconOptions {
  /** CSS size class: `sm` (16 px) or `lg` (24 px); default `sm`. */
  readonly size?: 'sm' | 'lg';
  /** Accessible name; omitted icons are decorative (`aria-hidden`). */
  readonly label?: string;
  /** Text used for the placeholder glyph when the icon is unknown. */
  readonly fallbackText?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Builds an inline SVG element for a Lucide icon name. */
export function icon(name: string | undefined, options: IconOptions = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `icon icon-${options.size ?? 'sm'}`);
  svg.setAttribute('focusable', 'false');
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const node = name ? ICONS.get(name) : undefined;
  if (node) {
    svg.dataset['icon'] = name;
    for (const [tag, attrs] of node) {
      const child = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs))
        if (v !== undefined) child.setAttribute(k, String(v));
      svg.appendChild(child);
    }
    return svg;
  }
  // Placeholder: dashed square with the first letter, so a missing icon is obvious in review.
  svg.dataset['icon'] = 'missing';
  svg.dataset['missingIcon'] = name ?? '';
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', '3');
  rect.setAttribute('y', '3');
  rect.setAttribute('width', '18');
  rect.setAttribute('height', '18');
  rect.setAttribute('rx', '2');
  rect.setAttribute('stroke-dasharray', '3 2');
  svg.appendChild(rect);
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', '12');
  text.setAttribute('y', '16');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-size', '11');
  text.setAttribute('fill', 'currentColor');
  text.setAttribute('stroke', 'none');
  text.textContent = (options.fallbackText ?? name ?? '?').charAt(0).toUpperCase();
  svg.appendChild(text);
  return svg;
}
