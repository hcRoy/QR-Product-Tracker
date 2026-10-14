import { Suspense, lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { RequireAdmin } from "./components/Layout";
import { Skeleton } from "./components/ui";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Products from "./pages/Products";
import ProductForm from "./pages/ProductForm";
import ProductDetail from "./pages/ProductDetail";
import ScanHistory from "./pages/ScanHistory";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";

// Heavy / public routes are code-split: Leaflet only loads on the map, and vendors never download the admin app.
const MapPage = lazy(() => import("./pages/MapPage"));
const Track = lazy(() => import("./pages/Track"));
const fallback = <div className="p-8"><Skeleton className="h-8 w-64" /></div>;

export default function App() {
  return (
    <Suspense fallback={fallback}>
      <Routes>
        <Route path="/track/:token" element={<Track />} />
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAdmin />}>
          <Route index element={<Dashboard />} />
          <Route path="products" element={<Products />} />
          <Route path="products/new" element={<ProductForm />} />
          <Route path="products/:id" element={<ProductDetail />} />
          <Route path="products/:id/edit" element={<ProductForm />} />
          <Route path="scans" element={<ScanHistory />} />
          <Route path="map" element={<MapPage />} />
          <Route path="reports" element={<Reports />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<div className="p-10 text-center text-slate-600">Page not found.</div>} />
      </Routes>
    </Suspense>
  );
}
