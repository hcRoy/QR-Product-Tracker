import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { searchUsers, setUserActive, setUserRole, type AccountRow, type AppRoleName } from "../lib/api";
import { Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, Pager, Select, TableSkeleton } from "../components/ui";
import { ConfirmDialog } from "../components/Dialog";

const ROLES: AppRoleName[] = ["admin", "vendor", "consumer"];

export default function Users() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [draft, setDraft] = useState<Record<string, AppRoleName>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState<AccountRow | null>(null);

  const query = useQuery({ queryKey: ["users", page, q, role], queryFn: () => searchUsers(page, q, role) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
  const saveRole = async (row: AccountRow) => {
    const next = draft[row.id] ?? row.role;
    if (next === row.role) return;
    setBusyId(row.id); setErr(null);
    try { await setUserRole(row.id, next); setDraft((d) => { const n = { ...d }; delete n[row.id]; return n; }); refresh(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusyId(null); }
  };
  const active = useMutation({
    mutationFn: (row: AccountRow) => setUserActive(row.id, !row.is_active),
    onSuccess: () => { setTarget(null); refresh(); },
  });

  return (
    <>
      <PageHeader title="Users" sub="Platform roles. People join as consumers; vendor access comes from an organization, not from inviting them one by one." />
      <Card className="mb-4 grid gap-3 md:grid-cols-3">
        <Input aria-label="Search users" placeholder="Name or id" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <Select aria-label="Role" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
          <option value="">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </Select>
      </Card>
      {err && <p role="alert" className="mb-3 text-sm text-red-600">{err}</p>}
      <Card className="!p-0 overflow-hidden">
        {query.isLoading ? <TableSkeleton /> : query.isError ? <div className="p-4"><ErrorState error={query.error} retry={() => query.refetch()} /></div> :
          query.data!.rows.length === 0 ? <div className="p-6"><EmptyState title="No users match" /></div> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="px-4 py-3">Name</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th><th className="px-4 py-3" />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {query.data!.rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3"><span className="font-medium">{row.full_name ?? "Unnamed"}</span><span className="block font-mono text-xs text-slate-400">{row.id.slice(0, 8)}</span></td>
                  <td className="px-4 py-3">
                    <Select aria-label={`Role for ${row.full_name ?? row.id}`} value={draft[row.id] ?? row.role} onChange={(e) => setDraft({ ...draft, [row.id]: e.target.value as AppRoleName })}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </td>
                  <td className="px-4 py-3"><Badge tone={row.is_active ? "green" : "slate"}>{row.is_active ? "active" : "deactivated"}</Badge></td>
                  <td className="space-x-2 whitespace-nowrap px-4 py-3 text-right">
                    <Button variant="secondary" disabled={busyId === row.id || (draft[row.id] ?? row.role) === row.role} onClick={() => saveRole(row)}>Save role</Button>
                    <Button variant={row.is_active ? "danger" : "secondary"} onClick={() => setTarget(row)}>{row.is_active ? "Deactivate" : "Reactivate"}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>)}
        {query.data && <Pager page={page} pageSize={query.data.page_size} total={query.data.total} onPage={setPage} />}
      </Card>
      <ConfirmDialog open={!!target} danger={target?.is_active} busy={active.isPending}
        title={target?.is_active ? "Deactivate this account?" : "Reactivate this account?"}
        body={target?.is_active ? "They lose access immediately, including admin access. The last active admin cannot be deactivated." : "They can sign in again with their current role."}
        confirmLabel={target?.is_active ? "Deactivate" : "Reactivate"}
        onClose={() => setTarget(null)}
        onConfirm={() => target && active.mutate(target)} />
      {active.isError && <p role="alert" className="mt-3 text-sm text-red-600">{(active.error as Error).message}</p>}
    </>
  );
}
