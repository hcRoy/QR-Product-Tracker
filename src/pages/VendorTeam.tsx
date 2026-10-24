import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { assignLocation, bulkImport, createDownstream, createJoinCode, inviteStaff, locationAssignees, myOrgs, orgClaims, orgDownstream, orgLocations, orgMembers, orgOverview, revokeClaim, setMemberStatus } from "../lib/phase2";
import { toCsv } from "../lib/csv";
import { downloadText } from "../lib/qr";
import { Button, Card, ErrorState, Field, Input, Select, Skeleton } from "../components/ui";

function parseCsv(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (cols[i] ?? "").trim(); });
    return row;
  });
}

export default function VendorTeam() {
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ["my-orgs"], queryFn: myOrgs });
  const [orgId, setOrgId] = useState("");
  const id = orgId || orgs.data?.[0]?.id || "";
  const overview = useQuery({ queryKey: ["org", id], queryFn: () => orgOverview(id), enabled: !!id });
  const members = useQuery({ queryKey: ["org-members", id], queryFn: () => orgMembers(id), enabled: !!id && !!overview.data?.is_manager });
  const downstream = useQuery({ queryKey: ["org-down", id], queryFn: () => orgDownstream(id), enabled: !!id && !!overview.data?.is_manager });
  const claims = useQuery({ queryKey: ["org-claims", id], queryFn: () => orgClaims(id), enabled: !!id && !!overview.data?.is_manager });
  const locations = useQuery({ queryKey: ["org-locs", id], queryFn: () => orgLocations(id), enabled: !!id && !!overview.data?.is_manager });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [csv, setCsv] = useState("name,email,city,type\n");
  const [importResult, setImportResult] = useState<string | null>(null);
  const [locId, setLocId] = useState("");
  const [userId, setUserId] = useState("");
  const assignees = useQuery({ queryKey: ["assignees", locId], queryFn: () => locationAssignees(locId), enabled: !!locId });

  const refresh = () => { qc.invalidateQueries({ queryKey: ["org-members"] }); qc.invalidateQueries({ queryKey: ["org-down"] }); qc.invalidateQueries({ queryKey: ["org-claims"] }); };
  const downstreamMut = useMutation({ mutationFn: () => createDownstream(id, name, "retailer", email, city), onSuccess: (r) => { setCode(r.code); refresh(); } });
  const invite = useMutation({ mutationFn: (role: string) => inviteStaff(id, role), onSuccess: (c) => { setCode(c); refresh(); } });
  const join = useMutation({ mutationFn: () => createJoinCode(id, 25), onSuccess: (c) => { setCode(c); refresh(); } });
  const dry = useMutation({ mutationFn: (confirm: boolean) => bulkImport(id, parseCsv(csv), !confirm), onSuccess: (r) => {
    setImportResult(`${r.dry_run ? "Dry run" : "Imported"}: ${r.error_count} error(s).`);
    if (!r.dry_run && r.codes.length) downloadText(toCsv([["name", "email", "code"], ...r.codes.map((c) => [c.name, c.email ?? "", c.code])]), "claim-codes.csv", "text/csv");
    refresh();
  } });

  if (orgs.isLoading) return <Skeleton className="h-24" />;
  if (orgs.isError) return <ErrorState error={orgs.error} retry={() => orgs.refetch()} />;
  if (!orgs.data?.length) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-brand">Team</h1>
        <p className="mt-2 text-sm text-slate-500">You are not a member of an organization yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-brand">Team</h1>
        <p className="mt-1 text-sm text-slate-500">
          {overview.data?.is_manager
            ? "Invite staff, create downstream claim links, and import organizations."
            : "Staff can see their own membership. Organization-wide tools are for owners and managers."}
        </p>
      </header>
      <Field label="Organization">
        <Select value={id} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.data.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.org_role}</option>)}
        </Select>
      </Field>
      {overview.data && !overview.data.is_manager && (
        <Card className="rounded-2xl"><p className="text-sm text-slate-600">{overview.data.name} is {overview.data.status}. Ask an owner to assign locations or invite people.</p></Card>
      )}
      {overview.data?.is_manager && (
        <div className="space-y-4">
          <Card className="space-y-3 rounded-2xl">
            <h2 className="font-semibold text-brand">People</h2>
            {(members.data ?? []).map((m) => (
              <div key={m.user_id} className="flex items-center justify-between gap-2 text-sm">
                <span>{m.full_name ?? m.user_id.slice(0, 8)} · {m.org_role} · {m.status}</span>
                {m.status === "active" && m.org_role !== "owner" && <Button variant="secondary" onClick={() => setMemberStatus(id, m.user_id, "suspended").then(refresh)}>Suspend</Button>}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => invite.mutate("staff")}>Invite staff</Button>
              <Button variant="secondary" onClick={() => invite.mutate("manager")}>Invite manager</Button>
              <Button variant="secondary" onClick={() => join.mutate()}>Join code (25 uses)</Button>
            </div>
          </Card>
          <Card className="space-y-3 rounded-2xl">
            <h2 className="font-semibold text-brand">Downstream organization</h2>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Email"><Input value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="City"><Input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
            <Button disabled={!name || downstreamMut.isPending} onClick={() => downstreamMut.mutate()}>Create claim link</Button>
            {(downstream.data ?? []).map((d) => <p key={d.id} className="text-sm">{d.name} · {d.status}{d.city ? ` · ${d.city}` : ""}</p>)}
          </Card>
          {code && (
            <Card className="rounded-2xl border-brand/20 bg-accent/40">
              <p className="text-sm text-slate-700">Give this code once. It will not be shown again.</p>
              <p className="mt-2 break-all font-mono text-sm text-brand">{code}</p>
              <p className="mt-2 text-xs text-slate-500">Claim link: {window.location.origin}/claim/{code}</p>
            </Card>
          )}
          <Card className="space-y-2 rounded-2xl">
            <h2 className="font-semibold text-brand">Claim codes</h2>
            {(claims.data ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between text-sm">
                <span>{c.kind} · {c.role} · {c.use_count}/{c.max_uses}{c.revoked ? " · revoked" : ""}</span>
                {!c.revoked && <Button variant="secondary" onClick={() => revokeClaim(c.id).then(refresh)}>Revoke</Button>}
              </div>
            ))}
          </Card>
          <Card className="space-y-3 rounded-2xl">
            <h2 className="font-semibold text-brand">Assign a location</h2>
            <Select value={locId} onChange={(e) => setLocId(e.target.value)}><option value="">Location</option>{(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Person</option>{(members.data ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name ?? m.user_id.slice(0, 8)}</option>)}</Select>
            <div className="flex gap-2">
              <Button disabled={!locId || !userId} onClick={() => assignLocation(locId, userId, true).then(() => qc.invalidateQueries({ queryKey: ["assignees", locId] }))}>Assign</Button>
              <Button variant="secondary" disabled={!locId || !userId} onClick={() => assignLocation(locId, userId, false).then(() => qc.invalidateQueries({ queryKey: ["assignees", locId] }))}>Remove</Button>
            </div>
            {assignees.data && <p className="text-xs text-slate-500">{assignees.data.length} person(s) assigned.</p>}
          </Card>
          <Card className="space-y-3 rounded-2xl">
            <h2 className="font-semibold text-brand">Bulk import</h2>
            <p className="text-xs text-slate-500">Header row required. Columns: name, email, phone, city, address, tax_id, type. Quoted commas are not supported. Dry run writes nothing.</p>
            <textarea className="block w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} />
            <div className="flex gap-2">
              <Button variant="secondary" disabled={dry.isPending} onClick={() => dry.mutate(false)}>Dry run</Button>
              <Button disabled={dry.isPending} onClick={() => dry.mutate(true)}>Import and download codes</Button>
            </div>
            {importResult && <p className="text-sm">{importResult}</p>}
            {dry.isError && <p role="alert" className="text-sm text-red-700">{(dry.error as Error).message}</p>}
          </Card>
        </div>
      )}
    </div>
  );
}
