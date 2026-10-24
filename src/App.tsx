import { Suspense, lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { RequireRole } from "./components/Layout";
import { Skeleton } from "./components/ui";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Products from "./pages/Products";
import ProductForm from "./pages/ProductForm";
import ProductDetail from "./pages/ProductDetail";
import ScanHistory from "./pages/ScanHistory";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";
import Organizations from "./pages/Organizations";
import Users from "./pages/Users";
import VendorHome from "./pages/VendorHome";
import VendorScan from "./pages/VendorScan";
import VendorScans from "./pages/VendorScans";
import VendorProducts from "./pages/VendorProducts";
import VendorShipments from "./pages/VendorShipments";
import VendorTeam from "./pages/VendorTeam";
import ConsumerHome from "./pages/ConsumerHome";
import ConsumerScan from "./pages/ConsumerScan";
import Register from "./pages/Register";
import Claim from "./pages/Claim";
import Locations from "./pages/Locations";
import ShipmentsAdmin from "./pages/ShipmentsAdmin";
import Discrepancies from "./pages/Discrepancies";

// Heavy / public routes are code-split: Leaflet only loads on the map, and vendors never download the admin app.
const MapPage = lazy(() => import("./pages/MapPage"));
const SupplyMap = lazy(() => import("./pages/SupplyMap"));
const Track = lazy(() => import("./pages/Track"));
const fallback = <div className="p-8"><Skeleton className="h-8 w-64" /></div>;

export default function App() {
  return (
    <Suspense fallback={fallback}>
      <Routes>
        <Route path="/track/:token" element={<Track />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/claim/:code" element={<Claim />} />
        <Route element={<RequireRole allow={["admin"]} variant="admin" />}>
          <Route index element={<Dashboard />} />
          <Route path="products" element={<Products />} />
          <Route path="products/new" element={<ProductForm />} />
          <Route path="products/:id" element={<ProductDetail />} />
          <Route path="products/:id/edit" element={<ProductForm />} />
          <Route path="scans" element={<ScanHistory />} />
          <Route path="map" element={<MapPage />} />
          <Route path="supply-map" element={<SupplyMap />} />
          <Route path="reports" element={<Reports />} />
          <Route path="locations" element={<Locations />} />
          <Route path="shipments" element={<ShipmentsAdmin />} />
          <Route path="discrepancies" element={<Discrepancies />} />
          <Route path="organizations" element={<Organizations />} />
          <Route path="users" element={<Users />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route element={<RequireRole allow={["vendor"]} variant="vendor" />}>
          <Route path="v" element={<VendorHome />} />
          <Route path="v/scan" element={<VendorScan />} />
          <Route path="v/scans" element={<VendorScans />} />
          <Route path="v/products" element={<VendorProducts />} />
          <Route path="v/shipments" element={<VendorShipments />} />
          <Route path="v/team" element={<VendorTeam />} />
        </Route>
        <Route element={<RequireRole allow={["consumer"]} variant="consumer" />}>
          <Route path="c" element={<ConsumerHome />} />
          <Route path="c/scan" element={<ConsumerScan />} />
        </Route>
        <Route path="*" element={<div className="p-10 text-center text-slate-600">Page not found.</div>} />
      </Routes>
    </Suspense>
  );
}
