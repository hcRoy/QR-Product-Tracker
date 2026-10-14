import { z } from "zod";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date").or(z.literal(""));
const optText = (max: number) => z.string().trim().max(max, `Max ${max} characters`);

export const productSchema = z
  .object({
    name: z.string().trim().min(1, "Product name is required").max(200, "Max 200 characters"),
    sku: optText(64),
    description: optText(2000),
    category: optText(100),
    batch_number: optText(64),
    manufacturing_date: dateStr,
    expiry_date: dateStr,
    unit_price: z.string().trim().refine((v) => v === "" || /^\d{1,10}(\.\d{1,2})?$/.test(v), "Enter an amount like 120 or 120.50"),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter code, e.g. INR"),
    package_quantity: z.string().trim().refine((v) => v === "" || (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 1e9), "Enter a whole number above 0"),
    unit_of_measure: optText(32),
    package_type: optText(100),
    package_description: optText(1000),
    manufacturer: optText(200),
    unit_count: z.string().trim().refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1000, "Enter 1 to 1000"),
  })
  .superRefine((v, ctx) => {
    if (v.manufacturing_date && v.expiry_date && v.expiry_date < v.manufacturing_date) {
      ctx.addIssue({ code: "custom", path: ["expiry_date"], message: "Expiry cannot be before manufacturing date" });
    }
  });

export type ProductFormValues = z.infer<typeof productSchema>;

export const emptyProductForm: ProductFormValues = {
  name: "", sku: "", description: "", category: "", batch_number: "", manufacturing_date: "", expiry_date: "",
  unit_price: "", currency: "INR", package_quantity: "", unit_of_measure: "", package_type: "",
  package_description: "", manufacturer: "", unit_count: "1",
};

/** Form strings -> API payload. Empty strings become null; unit_count is handled separately. */
export function toProductPayload(v: ProductFormValues) {
  const n = (s: string) => (s.trim() === "" ? null : s.trim());
  return {
    name: v.name.trim(), sku: n(v.sku), description: n(v.description), category: n(v.category),
    batch_number: n(v.batch_number), manufacturing_date: n(v.manufacturing_date), expiry_date: n(v.expiry_date),
    unit_price: v.unit_price === "" ? null : Number(v.unit_price), currency: v.currency.toUpperCase(),
    package_quantity: v.package_quantity === "" ? null : Number(v.package_quantity),
    unit_of_measure: n(v.unit_of_measure), package_type: n(v.package_type),
    package_description: n(v.package_description), manufacturer: n(v.manufacturer),
  };
}

export const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
export type LoginValues = z.infer<typeof loginSchema>;
