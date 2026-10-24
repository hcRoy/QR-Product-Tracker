import { useState, type ReactNode } from "react";
import { NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { homeForRole, type AppRole } from "../lib/roles";
import { IconHome, IconList, IconScan, IconTruck, IconUsers } from "./VendorIcons";
import { Button, Skeleton } from "./ui";

const NAV = [
  { to: "/", label: "Dashboard", end: true }, { to: "/products", label: "Products" },
  { to: "/scans", label: "Scan History" }, { to: "/map", label: "Location Map" },
  { to: "/reports", label: "Reports" }, { to: "/locations", label: "Locations" },
  { to: "/shipments", label: "Shipments" }, { to: "/discrepancies", label: "Discrepancies" },
  { to: "/supply-map", label: "Supply map" }, { to: "/organizations", label: "Organizations" },
  { to: "/users", label: "Users" }, { to: "/settings", label: "Settings" },
];

const link = ({ isActive }: { isActive: boolean }) =>
  `block rounded-lg px-3 py-2 text-sm font-medium ${isActive ? "bg-white/15 text-white" : "text-indigo-100 hover:bg-white/10"}`;

function useGate(allow: AppRole[]) {
  const { session, role, isActive, loading, signOut } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="p-10"><Skeleton className="h-8 w-64" /></div>;
  if (!session) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (!role) return (
    <div className="mx-auto mt-24 max-w-md rounded-xl border bg-white p-6 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-brand">Could not load your profile</h1>
      <Button className="mt-4" variant="secondary" onClick={signOut}>Sign out</Button>
    </div>
  );
  if (!isActive) return (
    <div className="mx-auto mt-24 max-w-md rounded-xl border bg-white p-6 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-brand">Account deactivated</h1>
      <p className="mt-2 text-sm text-slate-600">An administrator has deactivated this account.</p>
      <Button className="mt-4" variant="secondary" onClick={signOut}>Sign out</Button>
    </div>
  );
  if (!allow.includes(role)) return <Navigate to={homeForRole(role)} replace />;
  return null;
}

export function RequireRole({ allow, variant }: { allow: AppRole[]; variant: "admin" | "vendor" | "consumer" }) {
  const blocked = useGate(allow);
  if (blocked) return blocked;
  if (variant === "vendor") return <VendorShell />;
  if (variant === "consumer") return <ConsumerShell />;
  return <AdminShell />;
}

function AdminShell() {
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen md:flex">
      <aside className={`${open ? "block" : "hidden"} bg-brand p-4 md:sticky md:top-0 md:block md:h-screen md:w-60 md:shrink-0`}>
        <div className="mb-6 hidden px-3 text-lg font-semibold text-white md:block">QR Tracker</div>
        <nav aria-label="Main" className="space-y-1" onClick={() => setOpen(false)}>
          {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={link}>{n.label}</NavLink>)}
        </nav>
        <div className="mt-6 border-t border-white/20 pt-4 md:absolute md:bottom-4 md:left-4 md:right-4">
          <NavLink to="/settings" className={link}>Profile</NavLink>
          <button onClick={signOut} className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-indigo-100 hover:bg-white/10">Log out</button>
        </div>
      </aside>
      <div className="flex items-center justify-between bg-brand px-4 py-3 text-white md:hidden order-first">
        <span className="font-semibold">QR Tracker</span>
        <button aria-expanded={open} aria-label="Toggle menu" onClick={() => setOpen(!open)} className="rounded px-2 py-1 ring-1 ring-white/40">Menu</button>
      </div>
      <main className="min-w-0 flex-1 p-4 md:p-8"><Outlet /></main>
    </div>
  );
}

const VENDOR_NAV: { to: string; label: string; end?: boolean; icon: (p: { className?: string }) => ReactNode }[] = [
  { to: "/v", label: "Home", end: true, icon: (p) => <IconHome {...p} /> },
  { to: "/v/scan", label: "Scan", icon: (p) => <IconScan {...p} /> },
  { to: "/v/scans", label: "Scans", icon: (p) => <IconList {...p} /> },
  { to: "/v/shipments", label: "Shipments", icon: (p) => <IconTruck {...p} /> },
  { to: "/v/team", label: "Team", icon: (p) => <IconUsers {...p} /> },
];

const vendorSideLink = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
    isActive ? "bg-white/15 text-white" : "text-indigo-100 hover:bg-white/10 hover:text-white"
  }`;

function VendorShell() {
  const { signOut, name } = useAuth();
  return (
    <div className="min-h-[100dvh] md:flex">
      <aside className="hidden bg-brand md:sticky md:top-0 md:flex md:h-screen md:w-64 md:shrink-0 md:flex-col md:p-4 lg:w-72">
        <div className="mb-8 px-3">
          <p className="truncate text-lg font-semibold text-white">{name ?? "Vendor"}</p>
          <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-indigo-200">Vendor console</p>
        </div>
        <nav aria-label="Vendor" className="flex-1 space-y-1">
          {VENDOR_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={vendorSideLink}>
              {({ isActive }) => (
                <>
                  {item.icon({ className: isActive ? "text-white" : "text-indigo-200" })}
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <button
          type="button"
          onClick={signOut}
          className="mt-4 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-indigo-100 hover:bg-white/10"
        >
          Log out
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="vendor-mobile-header sticky top-0 z-20 flex items-center justify-between gap-3 bg-brand px-4 pb-3 text-white md:hidden">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold tracking-tight">{name ?? "Vendor"}</p>
            <p className="text-[11px] font-medium uppercase tracking-wide text-indigo-100/90">Vendor console</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-indigo-50 ring-1 ring-white/25 hover:bg-white/10"
          >
            Log out
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 pb-28 sm:px-6 md:px-8 md:py-8 md:pb-8 lg:px-10">
          <div className="mx-auto w-full max-w-6xl"><Outlet /></div>
        </main>

        <nav
          aria-label="Vendor"
          className="vendor-mobile-nav fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-slate-200/90 bg-white/95 px-1 pt-1 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] backdrop-blur md:hidden"
        >
          {VENDOR_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[10px] font-semibold tracking-wide ${
                  isActive ? "bg-accent text-brand" : "text-slate-500 hover:bg-slate-50 hover:text-brand"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {item.icon({ className: isActive ? "text-brand" : "text-slate-400" })}
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

function ConsumerShell() {
  const { signOut } = useAuth();
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="flex items-center justify-between px-4 py-3">
        <span className="font-semibold text-brand">QR Tracker</span>
        <button onClick={signOut} className="text-sm text-slate-500">Log out</button>
      </header>
      <main className="flex-1 p-4"><Outlet /></main>
      <nav aria-label="Consumer" className="grid grid-cols-2 border-t text-center text-xs font-medium text-brand">
        <NavLink to="/c" end className={({ isActive }) => `py-3 ${isActive ? "bg-accent" : ""}`}>Home</NavLink>
        <NavLink to="/c/scan" className={({ isActive }) => `py-3 ${isActive ? "bg-accent" : ""}`}>Scan</NavLink>
      </nav>
    </div>
  );
}
