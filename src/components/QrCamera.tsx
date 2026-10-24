import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

type BarcodeDetectorLike = {
  detect: (src: ImageBitmapSource) => Promise<{ rawValue: string }[]>;
};

function getBarcodeDetector(): BarcodeDetectorLike | null {
  const Ctor = (window as unknown as {
    BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
  }).BarcodeDetector;
  if (!Ctor) return null;
  try { return new Ctor({ formats: ["qr_code"] }); }
  catch { return null; }
}

function decodeWithJsQR(data: ImageData): string | null {
  const code = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
  return code?.data?.trim() || null;
}

async function decodeBitmap(bitmap: ImageBitmap, detector: BarcodeDetectorLike | null): Promise<string | null> {
  if (detector) {
    try {
      const codes = await detector.detect(bitmap);
      const value = codes[0]?.rawValue?.trim();
      if (value) return value;
    } catch { /* fall through to jsQR */ }
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  return decodeWithJsQR(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

/**
 * Live QR scanner: BarcodeDetector when the browser has it, otherwise jsQR on camera frames.
 * Photo capture is always available as a backup. Set continuous to keep scanning after each code.
 */
export function QrCamera({ onCode, continuous = false }: { onCode: (value: string) => void; continuous?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const [hint, setHint] = useState<string | null>(null);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [lastRead, setLastRead] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lastEmit = { value: "", at: 0 };
    const detector = getBarcodeDetector();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    function emit(value: string) {
      const now = Date.now();
      if (value === lastEmit.value && now - lastEmit.at < 2500) return;
      lastEmit.value = value;
      lastEmit.at = now;
      setLastRead(value.length > 48 ? `${value.slice(0, 48)}…` : value);
      onCodeRef.current(value);
      if (!continuous) stop = true;
    }

    async function tickNative() {
      if (stop || !video.current || !detector) return;
      try {
        const codes = await detector.detect(video.current);
        const value = codes[0]?.rawValue?.trim();
        if (value) emit(value);
      } catch { /* keep scanning */ }
      if (!stop) raf = requestAnimationFrame(() => { void tickNative(); });
    }

    function tickJsQR() {
      if (stop || !video.current || !ctx) return;
      const v = video.current;
      if (v.readyState >= 2 && v.videoWidth > 0) {
        const w = Math.min(v.videoWidth, 640);
        const h = Math.round((v.videoHeight / v.videoWidth) * w);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const value = decodeWithJsQR(ctx.getImageData(0, 0, w, h));
        if (value) emit(value);
      }
      if (!stop) timer = setTimeout(tickJsQR, 220);
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setHint("This device cannot open a live camera. Take a photo of the QR code instead.");
      return;
    }

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }).then((s) => {
      stream = s;
      if (!video.current || stop) { s.getTracks().forEach((t) => t.stop()); return; }
      video.current.srcObject = s;
      void video.current.play().then(() => {
        if (stop) return;
        setCameraReady(true);
        setHint(detector
          ? "Point the camera at a QR code."
          : "Point the camera at a QR code. Decoding runs in this browser.");
        if (detector) raf = requestAnimationFrame(() => { void tickNative(); });
        else tickJsQR();
      }).catch(() => setHint("Could not start the camera preview. Take a photo of the QR code instead."));
    }).catch(() => {
      setHint("Camera permission was denied. Take a photo of the QR code, or paste a code below.");
    });

    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [continuous]);

  async function onPhoto(file: File | undefined) {
    setPhotoErr(null);
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const value = await decodeBitmap(bitmap, getBarcodeDetector());
        if (value) {
          setLastRead(value.length > 48 ? `${value.slice(0, 48)}…` : value);
          onCodeRef.current(value);
        } else setPhotoErr("No QR code found in that photo. Try again closer and in better light.");
      } finally {
        bitmap.close();
      }
    } catch {
      setPhotoErr("Could not read that image. Try another photo.");
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="relative bg-slate-950">
        <video
          ref={video}
          muted
          playsInline
          className={`aspect-[4/3] w-full object-cover sm:aspect-square ${cameraReady ? "" : "min-h-48 opacity-40"}`}
        />
        {!cameraReady && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-slate-200">
            Starting camera…
          </p>
        )}
      </div>
      {hint && <p className="bg-slate-50 px-3 py-2 text-sm text-slate-600">{hint}</p>}
      {lastRead && (
        <p className="border-t border-slate-100 bg-emerald-50 px-3 py-2 font-mono text-xs text-emerald-900" aria-live="polite">
          Read: {lastRead}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-white p-3">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ""; }}
        />
        <button
          type="button"
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-600 sm:flex-none"
          onClick={() => fileInput.current?.click()}
        >
          Take photo of QR
        </button>
        <p className="w-full text-xs text-slate-500 sm:w-auto sm:flex-1">Use the camera above, or take a photo if live scan is awkward.</p>
      </div>
      {photoErr && <p role="alert" className="bg-amber-50 px-3 py-2 text-sm text-amber-900">{photoErr}</p>}
    </div>
  );
}
