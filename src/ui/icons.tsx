// Small geometric inline icons — stroke follows currentColor.
type P = { size?: number };

const S = (props: P) => ({
  width: props.size ?? 15,
  height: props.size ?? 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const GearIcon = (p: P) => (
  <svg {...S(p)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </svg>
);

export const SearchIcon = (p: P) => (
  <svg {...S(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const PlusIcon = (p: P) => (
  <svg {...S(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MicIcon = (p: P) => (
  <svg {...S(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export const PlayIcon = (p: P) => (
  <svg {...S(p)} fill="currentColor" stroke="none">
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
);

export const EyeIcon = (p: P) => (
  <svg {...S(p)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const MailIcon = (p: P) => (
  <svg {...S(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </svg>
);

export const DocIcon = (p: P) => (
  <svg {...S(p)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </svg>
);

export const NoteIcon = (p: P) => (
  <svg {...S(p)}>
    <path d="M4 4h16v12l-4 4H4z" />
    <path d="M16 20v-4h4M8 9h8M8 13h5" />
  </svg>
);

export const CoinIcon = (p: P) => (
  <svg {...S(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v9M9.5 9.8c0-1 1.1-1.8 2.5-1.8s2.5.8 2.5 1.8-1.1 1.7-2.5 1.9-2.5.9-2.5 1.9 1.1 1.8 2.5 1.8 2.5-.8 2.5-1.8" />
  </svg>
);

export const ContractIcon = (p: P) => (
  <svg {...S(p)}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h4" />
  </svg>
);

export const LinkIcon = (p: P) => (
  <svg {...S(p)}>
    <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" />
  </svg>
);

export const XIcon = (p: P) => (
  <svg {...S(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const ChevronRight = (p: P) => (
  <svg {...S(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const ChevronDown = (p: P) => (
  <svg {...S(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const FolderIcon = (p: P) => (
  <svg {...S(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

export const ArrowRightIcon = (p: P) => (
  <svg {...S(p)}>
    <path d="M4 12h16m-6-6 6 6-6 6" />
  </svg>
);
