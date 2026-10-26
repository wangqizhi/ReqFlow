// 极简内联 SVG 图标（16-20px 线性风格），避免引入图标库依赖。

type P = { size?: number; className?: string };
export const Settings = ({ size = 16, className }: P) => <svg {...svgProps(size)} className={className}><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></svg>;
export const Wand = ({ size = 16, className }: P) => <svg {...svgProps(size)} className={className}><path d="m3 18 11-11 4 4L7 22Z M11 10l4 4M5 2v4M3 4h4M19 2v4M17 4h4M20 16v4M18 18h4" /></svg>;

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  };
}

export const Plus = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M12 5v14M5 12h14" /></svg>
);
export const Layers = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 13 9 5 9-5" /></svg>
);
export const Server = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>
);
export const BarChart = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M4 3v18h17M8 16v-5M13 16V6M18 16v-8" /></svg>
);
export const FileText = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z" /><path d="M14 3v4h4" /><path d="M9 13h6M9 17h4" /></svg>
);
export const Copy = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
);
export const Download = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 19h16" /></svg>
);
export const Check = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="m4 12.5 5 5L20 6.5" /></svg>
);
export const RefreshCw = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
);
export const History = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>
);
export const Search = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const X = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
export const ChevronDown = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="m6 9 6 6 6-6" /></svg>
);
export const HelpCircle = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.2a2.6 2.6 0 0 1 5.1.7c0 1.7-2.6 2.2-2.6 3.6" /><path d="M12 17h.01" /></svg>
);
export const Terminal = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="m5 7 4 4-4 4" /><path d="M12 17h7" /><rect x="2" y="3" width="20" height="18" rx="2" /></svg>
);
export const FolderOpen = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v2" /><path d="M2.5 11h19l-2 9H4.5l-2-9Z" /></svg>
);
export const Folder = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
);
export const ChevronRight = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="m9 6 6 6-6 6" /></svg>
);
export const ListNumbers = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}>
    <path d="M9 6h12M9 12h12M9 18h12" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" strokeLinecap="round" strokeWidth={2.6} />
  </svg>
);
export const ImageIcon = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-4.35-4.35a1 1 0 0 0-1.42 0L5 21" /></svg>
);
export const GitBranch = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
);
export const Minus = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M5 12h14" /></svg>
);
export const Pencil = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z" /></svg>
);
export const Save = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></svg>
);
export const Eye = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const EyeOff = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M3 3l18 18M10 5.2a11 11 0 0 1 2-.2c6.5 0 10 7 10 7a18 18 0 0 1-3 3.8M6 6.5A20 20 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 5-1.3M10 10a3 3 0 0 0 4 4" /></svg>
);
export const ExternalLink = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
);
export const Trash = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" /><path d="M10 11v6M14 11v6" /></svg>
);
export const Play = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M7 4.8v14.4a.9.9 0 0 0 1.37.77l11.3-7.2a.9.9 0 0 0 0-1.54L8.37 4.03A.9.9 0 0 0 7 4.8Z" /></svg>
);
export const Maximize2 = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M15 4h5v5M9 20H4v-5M20 4l-6.5 6.5M4 20l6.5-6.5" /></svg>
);
export const Rocket = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg>
);
export const Globe = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
);
export const ShieldAlert = ({ size = 16, className }: P) => (
  <svg {...svgProps(size)} className={className}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="M12 8v4M12 16h.01" /></svg>
);
