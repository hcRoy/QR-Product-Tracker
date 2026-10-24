import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const IconHome = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" /></svg>
);
export const IconScan = (p: IconProps) => (
  <svg {...base} {...p}><path d="M7 4H5a1 1 0 0 0-1 1v2M17 4h2a1 1 0 0 1 1 1v2M7 20H5a1 1 0 0 1-1-1v-2M17 20h2a1 1 0 0 0 1-1v-2M8 12h8" /></svg>
);
export const IconList = (p: IconProps) => (
  <svg {...base} {...p}><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" /></svg>
);
export const IconTruck = (p: IconProps) => (
  <svg {...base} {...p}><path d="M3 7h11v10H3zM14 10h4l3 3v4h-7zM6 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M17 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3" /></svg>
);
export const IconUsers = (p: IconProps) => (
  <svg {...base} {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
);
export const IconBox = (p: IconProps) => (
  <svg {...base} {...p}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12 4 7.5" /></svg>
);
export const IconInbox = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 13h4l2 3h4l2-3h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 13l2.5-7h11L20 13" /></svg>
);
export const IconOutbox = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 11h4l2-3h4l2 3h4v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 3v8M9 6l3-3 3 3" /></svg>
);
