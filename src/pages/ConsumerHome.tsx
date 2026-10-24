import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { myApplication } from "../lib/phase2";
import { Button, Card, PageHeader } from "../components/ui";

export default function ConsumerHome() {
  const app = useQuery({ queryKey: ["my-application"], queryFn: myApplication });
  const pending = app.data && app.data.status !== "none" ? app.data : null;
  return (
    <>
      <PageHeader title="Your scans" sub="Open a product QR, or scan one here." actions={<Link to="/c/scan"><Button>Scan a code</Button></Link>} />
      <Card className="space-y-2">
        <p className="text-sm text-slate-600">Scanning shows that product only. A scan records that a device read the code. It does not prove the item is genuine, and it is not a list of everywhere the product has been unless the owner has turned that summary on.</p>
        {pending && <p className="text-sm text-slate-700">Vendor application for {pending.name}: <b>{pending.status}</b>. You can act on shipments only after it is active and you are assigned to a location.</p>}
      </Card>
    </>
  );
}
