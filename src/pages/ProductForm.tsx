import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createProduct, getProduct, updateProduct } from "../lib/api";
import { emptyProductForm, productSchema, type ProductFormValues } from "../lib/schemas";
import { Button, Card, ErrorState, Field, Input, PageHeader, Select, Skeleton, Textarea } from "../components/ui";

export default function ProductForm() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ["product", id], queryFn: () => getProduct(id!), enabled: editing });
  const { register, handleSubmit, reset, formState: { errors } } = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema), defaultValues: emptyProductForm });

  useEffect(() => {
    const p = existing.data; if (!p) return;
    reset({ ...emptyProductForm, name: p.name, sku: p.sku ?? "", description: p.description ?? "", category: p.category ?? "",
      batch_number: p.batch_number ?? "", manufacturing_date: p.manufacturing_date ?? "", expiry_date: p.expiry_date ?? "",
      unit_price: p.unit_price == null ? "" : String(p.unit_price), currency: p.currency.trim(), package_quantity: p.package_quantity == null ? "" : String(p.package_quantity),
      unit_of_measure: p.unit_of_measure ?? "", package_type: p.package_type ?? "", package_description: p.package_description ?? "", manufacturer: p.manufacturer ?? "" });
  }, [existing.data, reset]);

  const save = useMutation({
    mutationFn: async (v: ProductFormValues) => {
      if (editing) { await updateProduct(id!, v); return id!; }
      return (await createProduct(v)).product_id;
    },
    onSuccess: (pid) => {
      qc.invalidateQueries({ queryKey: ["products"] }); qc.invalidateQueries({ queryKey: ["product", pid] }); qc.invalidateQueries({ queryKey: ["metrics"] });
      nav(`/products/${pid}${editing ? "" : "?new=1"}`);
    },
  });

  if (editing && existing.isLoading) return <Skeleton className="h-96" />;
  if (editing && existing.isError) return <ErrorState error={existing.error} retry={() => existing.refetch()} />;
  const e = (k: keyof ProductFormValues) => errors[k]?.message;

  return (
    <>
      <PageHeader title={editing ? "Edit product" : "Add product"} sub={editing ? undefined : "Saving generates one unique QR code per physical unit."} />
      <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-5" noValidate>
        <Card className="grid gap-4 md:grid-cols-2">
          <h2 className="font-semibold text-slate-800 md:col-span-2">Product</h2>
          <Field label="Product name" required error={e("name")}><Input {...register("name")} /></Field>
          <Field label="SKU / product code" error={e("sku")} hint="The same SKU can be reused across different batches."><Input {...register("sku")} /></Field>
          <Field label="Category" error={e("category")}><Input {...register("category")} /></Field>
          <Field label="Manufacturer / brand" error={e("manufacturer")}><Input {...register("manufacturer")} /></Field>
          <div className="md:col-span-2"><Field label="Description" error={e("description")}><Textarea {...register("description")} /></Field></div>
        </Card>
        <Card className="grid gap-4 md:grid-cols-3">
          <h2 className="font-semibold text-slate-800 md:col-span-3">Batch and dates</h2>
          <Field label="Batch number" error={e("batch_number")}><Input {...register("batch_number")} /></Field>
          <Field label="Manufacturing date" error={e("manufacturing_date")}><Input type="date" {...register("manufacturing_date")} /></Field>
          <Field label="Expiry date" error={e("expiry_date")}><Input type="date" {...register("expiry_date")} /></Field>
        </Card>
        <Card className="grid gap-4 md:grid-cols-4">
          <h2 className="font-semibold text-slate-800 md:col-span-4">Pricing and package</h2>
          <Field label="Unit price" error={e("unit_price")}><Input inputMode="decimal" {...register("unit_price")} /></Field>
          <Field label="Currency" error={e("currency")}><Input maxLength={3} {...register("currency")} /></Field>
          <Field label="Package quantity" error={e("package_quantity")}><Input inputMode="numeric" {...register("package_quantity")} /></Field>
          <Field label="Unit of measure" error={e("unit_of_measure")}><Select {...register("unit_of_measure")}><option value="">—</option>{["pcs", "g", "kg", "ml", "L", "box", "pack"].map((u) => <option key={u}>{u}</option>)}</Select></Field>
          <Field label="Package type" error={e("package_type")}><Input {...register("package_type")} /></Field>
          <div className="md:col-span-3"><Field label="Package description" error={e("package_description")}><Input {...register("package_description")} /></Field></div>
        </Card>
        {!editing && (
          <Card className="max-w-md"><Field label="Physical units (QR codes) to generate" required error={e("unit_count")} hint="One QR per physical unit. You can add more later.">
            <Input inputMode="numeric" {...register("unit_count")} /></Field></Card>)}
        {save.isError && <p role="alert" className="text-sm text-red-600">{friendly((save.error as Error).message)}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : editing ? "Save changes" : "Create product and QR codes"}</Button>
          <Link to={editing ? `/products/${id}` : "/products"}><Button type="button" variant="secondary">Cancel</Button></Link>
        </div>
      </form>
    </>
  );
}

// Map database constraint errors to readable text without leaking internals.
function friendly(m: string) {
  if (m.includes("products_sku_batch_uniq")) return "A product with this SKU and batch already exists.";
  if (m.includes("products_dates_ok")) return "Expiry date cannot be before the manufacturing date.";
  if (m.includes("row-level security") || m.includes("forbidden")) return "You do not have permission to do this.";
  return "Could not save the product. Please check the values and try again.";
}
