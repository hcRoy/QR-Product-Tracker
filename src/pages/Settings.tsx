import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, saveSettings, type Settings as S } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, ErrorState, Field, Input, PageHeader, Skeleton } from "../components/ui";

const NUM: { k: keyof S; label: string; hint: string }[] = [
  { k: "min_rescan_seconds", label: "Rapid-repeat window (s)", hint: "Scans of one unit closer than this are flagged" },
  { k: "frequency_window_seconds", label: "Frequency window (s)", hint: "Window for counting scans" },
  { k: "frequency_max_scans", label: "Max scans per window", hint: "More than this is flagged as unusually frequent" },
  { k: "max_speed_kmh", label: "Max plausible speed (km/h)", hint: "Faster implied travel between GPS scans is flagged" },
  { k: "max_accuracy_m", label: "Low-accuracy threshold (m)", hint: "Readings worse than this are marked low accuracy" },
  { k: "location_retention_days", label: "Location retention (days)", hint: "Coordinates are removed after this by the scheduled purge job" },
  { k: "expiring_soon_days", label: "Expiring-soon window (days)", hint: "Used by the dashboard" },
];

export default function Settings() {
  const { session, name, signOut } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const { register, handleSubmit, reset } = useForm<S>();
  useEffect(() => { if (q.data) reset(q.data); }, [q.data, reset]);
  const save = useMutation({
    mutationFn: (v: S) => saveSettings({ ...v, ...Object.fromEntries(NUM.map(({ k }) => [k, Number(v[k])])) } as S),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); qc.invalidateQueries({ queryKey: ["metrics"] }); },
  });
  return (
    <>
      <PageHeader title="Settings" />
      <Card className="mb-5 max-w-xl"><h2 className="font-semibold">Profile</h2>
        <p className="mt-2 text-sm">{name ?? "Administrator"}</p><p className="text-sm text-slate-500">{session?.user.email}</p>
        <Button variant="secondary" className="mt-3" onClick={signOut}>Log out</Button></Card>
      <h2 className="mb-2 font-semibold text-slate-800">Tracking rules</h2>
      {q.isLoading ? <Skeleton className="h-64 max-w-xl" /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <form onSubmit={handleSubmit((v) => save.mutate(v))} className="max-w-xl space-y-4">
          <Card className="space-y-4">
            <Field label="Time zone" hint="IANA name, e.g. Asia/Kolkata. Used for “today” and expiry counts."><Input {...register("timezone")} /></Field>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" {...register("allow_scan_without_gps")} />
              <span><b>Record scans without GPS</b><span className="block text-xs text-slate-500">When off, scans are rejected unless location permission is granted.</span></span></label>
            {NUM.map(({ k, label, hint }) => <Field key={k} label={label} hint={hint}><Input type="number" min={0} {...register(k as never)} /></Field>)}
          </Card>
          {save.isError && <p role="alert" className="text-sm text-red-600">{(save.error as Error).message}</p>}
          {save.isSuccess && <p role="status" className="text-sm text-emerald-700">Settings saved.</p>}
          <Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save settings"}</Button>
        </form>)}
    </>
  );
}
