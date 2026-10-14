import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { listCategories, listProducts, setProductStatus, type ProductRow } from "../lib/api";
import { fmtCoords, fmtDate, fmtDateTime, fmtMoney, fmtPlace } from "../lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, Pager, Select, TableSkeleton } from "../components/ui";
import { ConfirmDialog } from "../components/Dialog";

const PAGE_SIZE = 15;
const useDebounced = <T,>(v: T, ms = 300) => { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; };

export default function Products() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [f, setF] = useState({ status: "", category: "", expiry: "", scanState: "" });
  const [archiving, setArchiving] = useState<ProductRow | null>(null);
  const dSearch = useDebounced(search);
  useEffect(() => setPage(1), [dSearch, f]);

  const q = useQuery({ queryKey: ["products", page, dSearch, f], placeholderData: keepPreviousData,
    queryFn: () => listProducts({ page, pageSize: PAGE_SIZE, search: dSearch, ...f }) });
  const cats = useQuery({ queryKey: ["categories"], queryFn: listCategories });
  const archive = useMutation({
    mutationFn: (id: string) => setProductStatus(id, "archived"),
    onSuccess: () => { setArchiving(null); qc.invalidateQueries({ queryKey: ["products"] }); qc.invalidateQueries({ queryKey: ["metrics"] }); },
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Products" sub="Each product has one QR code per physical unit." actions={<Link to="/products/new"><Button>Add product</Button></Link>} />
      <Card className="mb-4 grid gap-3 md:grid-cols-5">
        <Input className="md:col-span-2" type="search" aria-label="Search" placeholder="Search name, SKU or batch" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select aria-label="Status" value={f.status} onChange={set("status")}><option value="">All statuses</option><option value="active">Active</option><option value="archived">Archived</option></Select>
        <Select aria-label="Category" value={f.category} onChange={set("category")}><option value="">All categories</option>{cats.data?.map((c) => <option key={c}>{c}</option>)}</Select>
        <div className="grid grid-cols-2 gap-2">
          <Select aria-label="Expiry" value={f.expiry} onChange={set("expiry")}><option value="">Any expiry</option><option value="expired">Expired</option><option value="soon">Expiring ≤30d</option></Select>
          <Select aria-label="Scan state" value={f.scanState} onChange={set("scanState")}><option value="">Any scans</option><option value="scanned">Scanned</option><option value="never">Never scanned</option></Select>
        </div>
      </Card>
      <Card className="!p-0 overflow-hidden">
        {q.isLoading ? <TableSkeleton /> : q.isError ? <div className="p-4"><ErrorState error={q.error} retry={() => q.refetch()} /></div> :
          q.data!.rows.length === 0 ? <div className="p-6"><EmptyState title={dSearch || f.status || f.category || f.expiry || f.scanState ? "No products match these filters" : "No products yet"}>
            {!dSearch && <Link className="text-brand underline" to="/products/new">Register your first product</Link>}</EmptyState></div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                {["Product", "Batch", "Mfg / Expiry", "Price", "Status", "QR units", "Last scan", "Last reported location", "Created", ""].map((h) => <th key={h} className="whitespace-nowrap px-4 py-3">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {q.data!.rows.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><Link to={`/products/${p.id}`} className="font-medium text-brand hover:underline">{p.name}</Link><span className="block text-xs text-slate-500">{p.sku ?? "No SKU"}</span></td>
                    <td className="px-4 py-3">{p.batch_number ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs">{fmtDate(p.manufacturing_date)}<br />{fmtDate(p.expiry_date)} {p.is_expired && <Badge tone="red">Expired</Badge>}</td>
                    <td className="px-4 py-3">{fmtMoney(p.unit_price, p.currency)}</td>
                    <td className="px-4 py-3"><Badge tone={p.status === "active" ? "green" : "slate"}>{p.status}</Badge></td>
                    <td className="px-4 py-3">{p.unit_count > 0 ? <Badge tone="blue">{p.unit_count} generated</Badge> : <Badge tone="amber">None</Badge>}</td>
                    <td className="whitespace-nowrap px-4 py-3">{p.last_scan_at ? fmtDateTime(p.last_scan_at) : <Badge>Never scanned</Badge>}</td>
                    <td className="px-4 py-3 text-xs">{p.last_scan_at
                      ? (fmtPlace({ location_area: p.last_scan_area, location_city: p.last_scan_city, location_state: p.last_scan_state, location_country: p.last_scan_country })
                        ?? fmtCoords(p.last_scan_lat, p.last_scan_lon))
                      : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs">{fmtDate(p.created_at)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-xs">
                      <Link className="text-brand hover:underline" to={`/products/${p.id}`}>View</Link> ·{" "}
                      <Link className="text-brand hover:underline" to={`/products/${p.id}/edit`}>Edit</Link> ·{" "}
                      <Link className="text-brand hover:underline" to={`/products/${p.id}#units`}>QR</Link> ·{" "}
                      <Link className="text-brand hover:underline" to={`/scans?product=${p.id}`}>History</Link>
                      {p.status === "active" && <> · <button className="text-red-700 hover:underline" onClick={() => setArchiving(p)}>Archive</button></>}
                    </td>
                  </tr>))}
              </tbody>
            </table>
          </div>)}
        {q.data && <Pager page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} />}
      </Card>
      <ConfirmDialog open={!!archiving} onClose={() => setArchiving(null)} danger title="Archive product?" confirmLabel="Archive" busy={archive.isPending}
        body={<>Archiving <b>{archiving?.name}</b> stops all of its QR codes from recording new scans. History is kept. You can restore it later.
          {archive.isError && <span role="alert" className="mt-2 block text-red-600">{(archive.error as Error).message}</span>}</>}
        onConfirm={() => archiving && archive.mutate(archiving.id)} />
    </>
  );
}
