import { useState } from "react";
import { NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button, Skeleton } from "./ui";

const NAV = [
  { to: "/", label: "Dashboard", end: true }, { to: "/products", label: "Products" },
  { to: "/scans", label: "Scan History" }, { to: "/map", label: "Location Map" },
  { to: "/reports", label: "Reports" }, { to: "/settings", label: "Settings" },
];

export function RequireAdmin() {
  const { session, role, loading, signOut } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  if (loading) return <div className="p-10"><Skeleton className="h-8 w-64" /></div>;
  if (!session) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (role !== "admin") {
    return (
      <div className="mx-auto mt-24 max-w-md rounded-xl border bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-brand">Access denied</h1>
        <p className="mt-2 text-sm text-slate-600">This account is not an administrator. Ask an existing admin to grant access.</p>
        <Button className="mt-4" variant="secondary" onClick={signOut}>Sign out</Button>
      </div>
    );
  }
  const link = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm font-medium ${isActive ? "bg-white/15 text-white" : "text-indigo-100 hover:bg-white/10"}`;
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
