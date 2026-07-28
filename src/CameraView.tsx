import { useEffect, useRef, useState } from "react";
import { CameraIcon } from "./icons";

interface Props {
  onCapture: (photo: Blob) => void;
}

export default function CameraView({ onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch {
        // Fallback: no live camera access (e.g. permission denied or http).
        setError("live");
      }
    }

    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function snap() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    // Square crop, centered, capped at 1024px for cheap/fast inference.
    const size = Math.min(video.videoWidth, video.videoHeight);
    const target = Math.min(size, 1024);
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext("2d")!;
    const sx = (video.videoWidth - size) / 2;
    const sy = (video.videoHeight - size) / 2;
    ctx.drawImage(video, sx, sy, size, size, 0, 0, target, target);
    canvas.toBlob(
      (blob) => blob && onCapture(blob),
      "image/jpeg",
      0.85
    );
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onCapture(file);
  }

  return (
    <div className="camera">
      {error === "live" ? (
        <div className="camera-fallback">
          <div className="cam-badge">
            <CameraIcon size={40} strokeWidth={1.75} />
          </div>
          <h2 className="cam-title">Snap your meal</h2>
          <p className="cam-sub">
            Take a photo and we'll pull out the ingredients automatically.
          </p>
          <button className="primary cam-cta" onClick={() => fileRef.current?.click()}>
            Take photo
          </button>
        </div>
      ) : (
        <>
          <video ref={videoRef} autoPlay playsInline muted />
          <div className="camera-scrim" />
          <div className="camera-hint">Point at your plate</div>
          <div className="camera-controls">
            <button className="shutter" aria-label="Take photo" onClick={snap} />
          </div>
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={onFilePicked}
      />
    </div>
  );
}
