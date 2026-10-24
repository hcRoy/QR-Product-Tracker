import { useEffect, useRef, useState } from "react";

/** Uses the browser's built-in QR detector when the phone has one, and stops after the first code. */
export function QrCamera({ onCode }: { onCode: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setErr("This browser has no built-in QR detector. Paste the code or link below.");
      return;
    }
    let detector: { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
    try { detector = new Detector({ formats: ["qr_code"] }); }
    catch { setErr("This browser has no built-in QR detector. Paste the code or link below."); return; }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then((s) => {
      stream = s;
      if (!video.current || stop) { s.getTracks().forEach((t) => t.stop()); return; }
      video.current.srcObject = s;
      void video.current.play();
      const tick = () => {
        if (stop || !video.current) return;
        detector.detect(video.current).then((codes) => {
          if (codes[0]?.rawValue) { stop = true; onCodeRef.current(codes[0].rawValue); return; }
          if (!stop) requestAnimationFrame(tick);
        }).catch(() => { if (!stop) requestAnimationFrame(tick); });
      };
      requestAnimationFrame(tick);
    }).catch(() => setErr("Camera permission was denied. Paste the code or link instead."));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 shadow-sm">
      <video ref={video} muted playsInline className="aspect-[4/3] w-full object-cover sm:aspect-square" />
      {err && <p className="bg-amber-50 px-3 py-2 text-sm text-amber-900">{err}</p>}
    </div>
  );
}
