// Category → gradient glyph. Seven gradients, from tokens.css.
import type { Category } from "../storage/types";
import {
  CoinIcon,
  ContractIcon,
  DocIcon,
  EyeIcon,
  FolderIcon,
  MailIcon,
  NoteIcon,
} from "./icons";

import type { ReactElement } from "react";

const MAP: Record<Category, { grad: string; icon: (p: { size?: number }) => ReactElement }> = {
  Documents: { grad: "var(--grad-documents)", icon: DocIcon },
  Email: { grad: "var(--grad-email)", icon: MailIcon },
  Web: { grad: "var(--grad-web)", icon: ContractIcon },
  Notes: { grad: "var(--grad-notes)", icon: NoteIcon },
  Money: { grad: "var(--grad-money)", icon: CoinIcon },
  Watch: { grad: "var(--grad-watch)", icon: EyeIcon },
  Files: { grad: "var(--grad-files)", icon: FolderIcon },
};

export function CategoryGlyph({
  category,
  size,
}: {
  category: Category;
  size?: number;
}) {
  const m = MAP[category] ?? MAP.Files;
  const Icon = m.icon;
  return (
    <span
      className="glyph"
      style={{
        background: m.grad,
        ...(size ? { width: size, height: size } : {}),
      }}
    >
      <Icon size={size ? size * 0.54 : undefined} />
    </span>
  );
}
