import { useEffect, useRef, useState } from "react";

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
        <div className="sheet" style={{ justifyContent: "center" }}>
          <p className="status">
            Camera preview isn't available here. Tap below to take a photo.
          </p>
        </div>
      ) : (
        <video ref={videoRef} autoPlay playsInline muted />
      )}

      <div className="camera-controls">
        {error === "live" ? (
          <button className="primary" onClick={() => fileRef.current?.click()}>
            Take photo
          </button>
        ) : (
          <button
            className="shutter"
            aria-label="Take photo"
            onClick={snap}
          />
        )}
      </div>

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
