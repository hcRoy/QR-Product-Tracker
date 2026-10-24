import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createOrg, searchOrgs, setOrgStatus, type OrgRow } from "../lib/api";
import { Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, Pager, Select, TableSkeleton } from "../components/ui";
import { ConfirmDialog } from "../components/Dialog";

const TYPES = ["manufacturer", "distributor", "retailer", "warehouse", "other"] as const;
const STATUSES = ["pending", "active", "suspended", "rejected"] as const;
const tone = { pending: "amber", active: "green", suspended: "red", rejected: "slate" } as const;

export default function Organizations() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [form, setForm] = useState({ name: "", type: "distributor", taxId: "" });
  const [target, setTarget] = useState<{ org: OrgRow; status: "active" | "suspended" | "rejected" } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["orgs", page, q, status], queryFn: () => searchOrgs(page, q, status) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["orgs"] });
  const create = useMutation({
    mutationFn: () => createOrg(form.name.trim(), form.type, "", form.taxId.trim()),
    onSuccess: () => { setForm({ name: "", type: "distributor", taxId: "" }); setErr(null); refresh(); },
    onError: (e: Error) => setErr(e.message),
  });
  const change = useMutation({
    mutationFn: ({ org, status: next, note }: { org: OrgRow; status: "active" | "suspended" | "rejected"; note: string }) => setOrgStatus(org.id, next, note),
    onSuccess: () => { setTarget(null); refresh(); },
  });

  return (
    <>
      <PageHeader title="Organizations" sub="Vendors belong to an organization. Approving every person by hand is not required; this list is for exceptions." />
      <Card className="mb-4 grid gap-3 md:grid-cols-4">
        <Input aria-label="Organization name" placeholder="New organization name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Select aria-label="Organization type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Input aria-label="Tax id" placeholder="Tax id (optional)" value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
        <Button disabled={create.isPending || form.name.trim().length < 1} onClick={() => create.mutate()}>{create.isPending ? "Creating…" : "Create"}</Button>
      </Card>
      {err && <p role="alert" className="mb-3 text-sm text-red-600">{err}</p>}
      <Card className="mb-4 grid gap-3 md:grid-cols-3">
        <Input aria-label="Search organizations" placeholder="Name or tax id" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </Card>
      <Card className="!p-0 overflow-hidden">
        {query.isLoading ? <TableSkeleton /> : query.isError ? <div className="p-4"><ErrorState error={query.error} retry={() => query.refetch()} /></div> :
          query.data!.rows.length === 0 ? <div className="p-6"><EmptyState title="No organizations yet" /></div> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="px-4 py-3">Organization</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Parent</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Members</th><th className="px-4 py-3" />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {query.data!.rows.map((org) => (
                <tr key={org.id}>
                  <td className="px-4 py-3"><span className="font-medium">{org.name}</span>{org.tax_id_normalized && <span className="block text-xs text-slate-400">{org.tax_id_normalized}</span>}</td>
                  <td className="px-4 py-3">{org.type}</td>
                  <td className="px-4 py-3">{org.parent_name ?? "—"}</td>
                  <td className="px-4 py-3"><Badge tone={tone[org.status]}>{org.status}</Badge></td>
                  <td className="px-4 py-3">{org.member_count}</td>
                  <td className="space-x-2 whitespace-nowrap px-4 py-3 text-right">
                    {org.status !== "active" && <Button variant="secondary" onClick={() => setTarget({ org, status: "active" })}>Reinstate</Button>}
                    {org.status === "active" && <Button variant="danger" onClick={() => setTarget({ org, status: "suspended" })}>Suspend</Button>}
                    {org.status === "pending" && <Button variant="danger" onClick={() => setTarget({ org, status: "rejected" })}>Reject</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>)}
        {query.data && <Pager page={page} pageSize={query.data.page_size} total={query.data.total} onPage={setPage} />}
      </Card>
      <ConfirmDialog open={!!target} danger={target?.status !== "active"} withReason busy={change.isPending}
        title={target ? `${target.status === "active" ? "Reinstate" : target.status === "suspended" ? "Suspend" : "Reject"} ${target.org.name}?` : ""}
        body="A suspended or rejected organization cannot act. The reason is stored in the audit log."
        confirmLabel={target?.status === "active" ? "Reinstate" : target?.status === "suspended" ? "Suspend" : "Reject"}
        onClose={() => setTarget(null)}
        onConfirm={(note) => target && change.mutate({ ...target, note })} />
      {change.isError && <p role="alert" className="mt-3 text-sm text-red-600">{(change.error as Error).message}</p>}
    </>
  );
}
