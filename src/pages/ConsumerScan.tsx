import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { QrCamera } from "../components/QrCamera";
import { extractToken } from "../lib/scanToken";
import { Button, Card, Field, Input } from "../components/ui";

export default function ConsumerScan() {
  const nav = useNavigate();
  const [raw, setRaw] = useState("");
  const token = useMemo(() => extractToken(raw), [raw]);

  function open(value: string) {
    const found = extractToken(value);
    if (found) nav(`/track/${found}`);
    else setRaw(value);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand">Scan a product</h1>
      <QrCamera onCode={open} />
      <Card>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (token) nav(`/track/${token}`); }}>
          <Field label="Code or link" hint="Paste the QR text if the camera cannot read it."><Input value={raw} onChange={(e) => setRaw(e.target.value)} /></Field>
          {raw && !token && <p className="text-sm text-red-700">That is not a product code.</p>}
          <Button type="submit" className="w-full" disabled={!token}>Open product</Button>
        </form>
      </Card>
    </div>
  );
}
